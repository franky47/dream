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

Cron, webhook and subagent sessions stay out of the archive. Each selected
session yields one JSONL file under the UTC day of its latest message. A session
with no compaction also yields one Markdown file. A session compacted once in
place splits into two context-window fragments, `<id>.1.md` and `<id>.2.md`.

Each fragment carries its own frontmatter (times, turns and tool counts for that
window) plus a `contextWindow` number; the first also names its
`nextContextWindow` and ends with a relative Markdown link to the second. The
second fragment opens with a `<compaction>` block holding the summary Hermes sent
to the model — its turn number, stored role and relative time, with the safety
prefix and end marker stripped — and then repeats the recent tail Hermes
preserved, so the file matches the context the model saw. The raw JSONL keeps
every archived and live row untouched, including each message's `activity` state.

The raw JSONL keeps the full source record: system prompt, model and model
settings, usage, lineage, archive state, platform origin, and per-message
reasoning and provider metadata. The Markdown stays readable by omitting the
system prompt, model settings and reasoning, while its frontmatter lists every
platform ID a session carries (channel, thread, guild, author). A session with
no such data simply omits those fields, so nothing shows a placeholder ID.

This project was created using `bun init` in bun v1.3.11. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
