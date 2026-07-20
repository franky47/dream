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
once in place splits into two context-window fragments, `<id>.1.md` and
`<id>.2.md`.

Each fragment carries its own frontmatter (times, turns and tool counts for that
window) plus a `contextWindow` number; the first also names its
`nextContextWindow` and ends with a relative Markdown link to the second. The
second fragment opens with a `<compaction>` block holding the summary Hermes sent
to the model — its turn number, stored role and relative time, with the safety
prefix and end marker stripped — and then repeats the recent tail Hermes
preserved, so the file matches the context the model saw. The raw JSONL keeps
every archived and live row untouched, including each message's `active` state.

The raw JSONL keeps the full source record: system prompt, model and model
settings, usage, lineage, archive state, platform origin, and per-message
reasoning and provider metadata. The Markdown stays readable by omitting the
system prompt, model settings and reasoning, while its frontmatter lists every
platform ID a session carries (channel, thread, guild, author). A session with
no such data simply omits those fields, so nothing shows a placeholder ID.

For Discord-sourced turns, the Markdown drops the fixed note Hermes injects to
tell its reply tool which message triggered the run. Sender, reply and
attachment context stay in place, and the raw JSONL keeps the stored text as-is.

Tool calls render in a Hermes-specific style. The renderer pairs each tool
call with its result by call id and gives terminal, read, write, patch,
search, todo and clarify their own concise shapes: terminal and patch keep
their command, status and diff, while a write keeps its file statistics
instead of the whole payload. Any other tool falls back to a compact
self-closing `<tool>` tag, so a new Hermes tool never breaks the render. A
failed tool carries an `error="1"` marker.

This project was created using `bun init` in bun v1.3.11. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
