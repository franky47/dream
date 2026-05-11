import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import * as errore from 'errore'

import { parseConfig } from '#src/config'
import { buildRunLog } from '#src/ingest/log'
import { run, type Source } from '#src/ingest/orchestrator'
import { ingestLocalClaude } from '#src/ingest/sources/local-claude'
import { ingestLocalFirefox } from '#src/ingest/sources/local-firefox'
import { ingestLocalOpencode } from '#src/ingest/sources/local-opencode'
import { ingestSshClaude } from '#src/ingest/sources/ssh-claude'

const INGEST_WINDOW_HOURS = 48

class IngestFatal extends errore.createTaggedError({
  name: 'IngestFatal',
  message: 'Ingest cannot continue: $reason',
}) {}

function utcDateStamp(d: Date): string {
  return d.toISOString().slice(0, 10)
}

async function main(): Promise<number> {
  const cfg = parseConfig(process.env)
  if (cfg instanceof Error) {
    console.error(cfg.message)
    return 1
  }

  const since = new Date(Date.now() - INGEST_WINDOW_HOURS * 60 * 60 * 1000)
  const sources: Source[] = [
    ingestLocalClaude({
      machine: cfg.machine,
      sourceDir: path.join(homedir(), '.claude', 'projects'),
    }),
    ingestLocalOpencode({ machine: cfg.machine }),
    ...cfg.remoteClaudeHosts.map((host) => ingestSshClaude({ host })),
    ...cfg.firefoxProfiles.map((name) =>
      ingestLocalFirefox({
        machine: cfg.machine,
        profileDir: path.join(
          homedir(),
          'Library',
          'Application Support',
          'Firefox',
          'Profiles',
          name,
        ),
        blocklistPath: fileURLToPath(
          new URL('../../config/firefox-blocklist.txt', import.meta.url),
        ),
      }),
    ),
  ]

  const outcome = await run({ sources, dataDir: cfg.dataDir, since })

  const metaDir = path.join(cfg.dataDir, 'raw', '_meta')
  const prep = await mkdir(metaDir, { recursive: true }).catch(
    (e) => new IngestFatal({ reason: `mkdir ${metaDir}`, cause: e }),
  )
  if (prep instanceof Error) {
    console.error(prep.message)
    return 1
  }

  const logPath = path.join(
    metaDir,
    `${utcDateStamp(outcome.runStartedAt)}.json`,
  )
  const payload = buildRunLog({
    runStartedAt: outcome.runStartedAt,
    runFinishedAt: outcome.runFinishedAt,
    results: outcome.results,
  })
  const written = await writeFile(
    logPath,
    JSON.stringify(payload, null, 2) + '\n',
    'utf-8',
  ).catch((e) => new IngestFatal({ reason: `write ${logPath}`, cause: e }))
  if (written instanceof Error) {
    console.error(written.message)
    return 1
  }

  for (const r of outcome.results) {
    const tag = `${r.machine}/${r.source}`
    if (r.status === 'ok') {
      console.log(
        `[ok]    ${tag} ${r.durationMs}ms ${JSON.stringify(r.metrics)}`,
      )
    } else {
      console.warn(`[error] ${tag} ${r.durationMs}ms ${r.error.message}`)
    }
  }
  console.log(`run log: ${logPath}`)
  return 0
}

const exitCode = await main().catch((e) => {
  console.error('unhandled error:', e instanceof Error ? e.stack : String(e))
  return 1
})
process.exit(exitCode)
