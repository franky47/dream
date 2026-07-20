# dream

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run
```

## Remote sources

Remote sources read another machine over your existing SSH setup. List their
hosts in comma-separated environment variables. Each host becomes one source
and one machine bucket in the data layout:

- `DREAM_REMOTE_CLAUDE_HOSTS`
- `DREAM_REMOTE_OPENCODE_HOSTS`
- `DREAM_REMOTE_HERMES_HOSTS`

### Hermes

`DREAM_REMOTE_HERMES_HOSTS=echo,other-host` ingests human-led Hermes sessions
from each host. The source reads the Hermes state database
(`$HOME/.hermes/state.db` by default) in read-only mode over
`ssh -o BatchMode=yes <host>`, so it never
writes to the live database. Each host must therefore allow key-based SSH with
no prompt and have the `sqlite3` command-line client on its `PATH`.

Cron, webhook and subagent sessions stay out of the archive. User-created
branches ingest as their own human sessions, and archived sessions are kept —
their Markdown carries `archived: true`, which is absent on live sessions. Each
selected session yields one JSONL file under the UTC day of its latest message.
A session with no compaction also yields one Markdown file. A session compacted
in place splits into one context-window fragment per window: N compactions
produce N+1 fragments, `<id>.1.md` through `<id>.N+1.md`.

When Hermes rotates a session, it opens a fresh session that begins with a
compaction summary and points back to the one it continues. The source joins a
root and its rotated continuations into one logical session under the root's
UUID: the JSONL keeps every physical session id, parent link and source in chain
order, and the Markdown renders one context-window fragment per rotation, just
like an in-place compaction. Selection, day routing, archive state and metrics
follow the joined conversation, so its latest message across all rotations
decides which window and day it lands in. A user-created branch opens with an
ordinary turn rather than a summary, so it stays its own session; a continuation
whose parent is missing stands on its own rather than disappearing.

Each fragment carries its own frontmatter (times, turns and tool counts for that
window) plus a `contextWindow` number; every fragment but the last also names its
`nextContextWindow` and ends with a relative Markdown link to the next. Each
post-compaction fragment opens with a `<compaction>` block holding the summary
Hermes sent to the model. The block is the window's first turn: it takes turn
number 1, its stored role, and the window's relative-time origin, so the body
turns that follow it number from 2 and count their elapsed time from the summary.
The renderer strips the summary's safety prefix and end marker, then repeats the
recent tail Hermes preserved, so the file matches the context the model saw. Only
one summary marker form appears in live Hermes data — a fixed instruction prefix
wrapping the Markdown summary, closed by a fixed end marker — and that is the only
form detected. No legacy short-tag or merged-marker form showed up in any live
session, so the renderer deliberately does not guess at them. Markers are stripped
from Markdown but stay untouched in the raw JSONL, which keeps every archived and
live row including each message's `active` state. A joined chain describes the
whole logical session: any archived member marks the joined session archived, and
platform IDs fold across every physical member.

The raw JSONL keeps the full source record: system prompt, model and model
settings, usage, lineage, archive state, platform origin, and per-message
reasoning and provider metadata. The Markdown stays readable by omitting the
system prompt, model settings and reasoning, while its frontmatter lists every
platform ID a session carries (channel, thread, guild, author). A session with
no such data simply omits those fields, so nothing shows a placeholder ID.

For Discord-sourced turns, the Markdown drops the fixed note Hermes injects to
tell its reply tool which message triggered the run. Sender, reply and
attachment context stay in place, and the raw JSONL keeps the stored text as-is.

Tool calls render in a Hermes-specific style. The renderer pairs each tool call
with its result by call id and gives `terminal`, `skill_view`, `read_file`,
`write_file`, `patch`, `search_files`, `todo` and `clarify` their own concise
shapes: `terminal` keeps its command and output and shows the exit code on a
failed run, `read_file` and `search_files` keep the path, slice bounds or match
count instead of the large body, and `write_file` keeps its resolved path and
byte count instead of the whole payload. Any other tool falls back to a compact
self-closing `<tool>` tag, so a new Hermes tool never breaks the render; a
hostile input key is escaped into the body rather than injected as raw markup. A
failed tool carries an `error="1"` marker. A run failed when its result reports a
non-zero `exit_code` or a non-null `error`.

This project was created using `bun init` in bun v1.3.11. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
