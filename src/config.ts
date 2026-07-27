import * as errore from 'errore'
import { z } from 'zod'

export class ConfigError extends errore.createTaggedError({
  name: 'ConfigError',
  message: 'Invalid configuration: $reason',
}) {}

const configSchema = z.object({
  DREAM_DATA_DIR: z.string().min(1),
  DREAM_MACHINE: z.string().min(1).default('local'),
  DREAM_REMOTE_CLAUDE_HOSTS: z.string().default(''),
  DREAM_REMOTE_OPENCODE_HOSTS: z.string().default(''),
  DREAM_REMOTE_HERMES_HOSTS: z.string().default(''),
  DREAM_FIREFOX_PROFILES: z.string().default(''),
})

export type Config = {
  dataDir: string
  machine: string
  remoteClaudeHosts: string[]
  remoteOpencodeHosts: string[]
  remoteHermesHosts: string[]
  firefoxProfiles: string[]
}

function parseList(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

// A host reaches both a filesystem bucket path and the ssh argv, so anything
// that could traverse directories, split shell words, or parse as an ssh option
// is rejected outright. Returns a human-readable defect, or null when clean.
function hostDefect(host: string): string | null {
  if (/[\s/\\]/.test(host)) return 'contains whitespace or a path separator'
  if (host.includes('..')) return 'contains ".."'
  if (host.startsWith('-')) return 'starts with "-"'
  return null
}

function parseHostList(raw: string, varName: string): string[] | ConfigError {
  const hosts = parseList(raw)
  for (const host of hosts) {
    const defect = hostDefect(host)
    if (defect !== null) {
      return new ConfigError({
        reason: `${varName} entry ${JSON.stringify(host)} ${defect}`,
      })
    }
  }
  return hosts
}

export function parseConfig(
  env: Record<string, string | undefined>,
): Config | ConfigError {
  const parsed = configSchema.safeParse(env)
  if (!parsed.success) {
    return new ConfigError({
      reason: z.prettifyError(parsed.error),
      cause: parsed.error,
    })
  }

  const remoteClaudeHosts = parseHostList(
    parsed.data.DREAM_REMOTE_CLAUDE_HOSTS,
    'DREAM_REMOTE_CLAUDE_HOSTS',
  )
  if (remoteClaudeHosts instanceof Error) return remoteClaudeHosts

  const remoteOpencodeHosts = parseHostList(
    parsed.data.DREAM_REMOTE_OPENCODE_HOSTS,
    'DREAM_REMOTE_OPENCODE_HOSTS',
  )
  if (remoteOpencodeHosts instanceof Error) return remoteOpencodeHosts

  const remoteHermesHosts = parseHostList(
    parsed.data.DREAM_REMOTE_HERMES_HOSTS,
    'DREAM_REMOTE_HERMES_HOSTS',
  )
  if (remoteHermesHosts instanceof Error) return remoteHermesHosts

  return {
    dataDir: parsed.data.DREAM_DATA_DIR,
    machine: parsed.data.DREAM_MACHINE,
    remoteClaudeHosts,
    remoteOpencodeHosts,
    remoteHermesHosts,
    firefoxProfiles: parseList(parsed.data.DREAM_FIREFOX_PROFILES),
  }
}
