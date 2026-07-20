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
selected session yields one JSONL file and one Markdown file under the UTC day of
its latest message.

This project was created using `bun init` in bun v1.3.11. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
