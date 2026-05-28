import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseConfig } from '#src/config'
import { buildRunLog, runLogFileName } from '#src/ingest/log'
import { IngestFatal, run, type Source } from '#src/ingest/orchestrator'
import { ingestLocalClaude } from '#src/ingest/sources/local-claude'
import { ingestLocalCodex } from '#src/ingest/sources/local-codex'
import { ingestLocalFirefox } from '#src/ingest/sources/local-firefox'
import { ingestLocalOpencode } from '#src/ingest/sources/local-opencode'
import { ingestSshClaude } from '#src/ingest/sources/ssh-claude'
import { ingestSshOpencode } from '#src/ingest/sources/ssh-opencode'
import { resolveWindow } from '#src/ingest/window'

async function main(): Promise<number> {
  const cfg = parseConfig(process.env)
  if (cfg instanceof Error) {
    console.error(cfg.message)
    return 1
  }

  const windowResult = resolveWindow(process.argv.slice(2), new Date())
  if (windowResult instanceof Error) {
    console.error(windowResult.message)
    return 1
  }
  const { since, until, untilWasExplicit } = windowResult

  const sources: Source[] = [
    ingestLocalClaude({
      machine: cfg.machine,
      sourceDir: path.join(homedir(), '.claude', 'projects'),
    }),
    ingestLocalOpencode({ machine: cfg.machine }),
    ingestLocalCodex({
      machine: cfg.machine,
      sourceDir: path.join(homedir(), '.codex'),
    }),
    ...cfg.remoteClaudeHosts.map((host) => ingestSshClaude({ host })),
    ...cfg.remoteOpencodeHosts.map((host) => ingestSshOpencode({ host })),
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
        // A backfill run (explicit --until) only writes past day-buckets, so
        // the "now" snapshot sub-sources are skipped.
        includeSnapshots: !untilWasExplicit,
      }),
    ),
  ]

  const outcome = await run({ sources, dataDir: cfg.dataDir, since, until })
  if (outcome instanceof Error) {
    console.error(outcome.message)
    return 1
  }

  const metaDir = path.join(cfg.dataDir, '_meta')
  const prep = await mkdir(metaDir, { recursive: true }).catch(
    (e) => new IngestFatal({ reason: `mkdir ${metaDir}`, cause: e }),
  )
  if (prep instanceof Error) {
    console.error(prep.message)
    return 1
  }

  const logPath = path.join(metaDir, runLogFileName(outcome.runStartedAt))
  const payload = buildRunLog({
    runStartedAt: outcome.runStartedAt,
    runFinishedAt: outcome.runFinishedAt,
    since,
    until,
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
