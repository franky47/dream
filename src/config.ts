import * as errore from 'errore'
import { z } from 'zod'

export class ConfigError extends errore.createTaggedError({
  name: 'ConfigError',
  message: 'Invalid configuration: $reason',
}) {}

const configSchema = z.object({
  DREAM_DATA_DIR: z.string().min(1),
  DREAM_MACHINE: z.string().min(1).default('local'),
  DREAM_REMOTE_CLAUDE_SESSIONS_HOSTS: z.string().default(''),
})

export type Config = {
  dataDir: string
  machine: string
  remoteClaudeSessionsHosts: string[]
}

function parseHostList(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
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
  return {
    dataDir: parsed.data.DREAM_DATA_DIR,
    machine: parsed.data.DREAM_MACHINE,
    remoteClaudeSessionsHosts: parseHostList(
      parsed.data.DREAM_REMOTE_CLAUDE_SESSIONS_HOSTS,
    ),
  }
}
