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
session yields one JSONL file and one Markdown file under the UTC day of its
latest message.

For Discord-sourced turns, the Markdown drops the fixed note Hermes injects to
tell its reply tool which message triggered the run. Sender, reply and
attachment context stay in place, and the raw JSONL keeps the stored text as-is.

This project was created using `bun init` in bun v1.3.11. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
