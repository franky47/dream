import { parseArgs } from 'node:util'

import * as errore from 'errore'
import { z } from 'zod'

export const sourceNames = [
  'claude',
  'codex',
  'firefox',
  'hermes',
  'opencode',
  'pi',
] as const

const sourceNameSchema = z.enum(sourceNames)

const transportSchema = z.enum(['local', 'remote'])
export type Transport = z.infer<typeof transportSchema>

export class CliError extends errore.createTaggedError({
  name: 'CliError',
  message: 'Invalid arguments: $reason',
}) {}

export const usage = `Usage: bun run ingest [options]

Options:
  --since <date>       Start of ingest window (ISO date or datetime).
                       Defaults to 48h before --until.
  --until <date>       End of ingest window (ISO date or datetime).
                       Requires --since. Defaults to now.
  -s, --source <term>  Only pull matching sources. Repeatable (union).
                       Term: <name> or <name>:<local|remote>.
                       Names: ${sourceNames.join(', ')}
  -h, --help           Show this help.`

const sourceTermSchema = z.string().transform((raw, ctx) => {
  const [namePart, transportPart, ...excess] = raw.split(':')
  if (excess.length > 0) {
    ctx.addIssue({
      code: 'custom',
      message: `malformed source term "${raw}": expected <name> or <name>:<local|remote>`,
    })
    return z.NEVER
  }
  const name = sourceNameSchema.safeParse(namePart)
  if (!name.success) {
    ctx.addIssue({
      code: 'custom',
      message: `unknown source "${namePart ?? ''}": valid names are ${sourceNames.join(', ')}`,
    })
    return z.NEVER
  }
  if (transportPart === undefined) {
    return { raw, name: name.data, transport: null }
  }
  const transport = transportSchema.safeParse(transportPart)
  if (!transport.success) {
    ctx.addIssue({
      code: 'custom',
      message: `unknown location "${transportPart}" in source term "${raw}": use local or remote`,
    })
    return z.NEVER
  }
  return { raw, name: name.data, transport: transport.data }
})

export type SourceFilter = z.infer<typeof sourceTermSchema>

const cliValuesSchema = z.object({
  since: z.string().optional(),
  until: z.string().optional(),
  source: z.array(sourceTermSchema).default([]),
  help: z.boolean().default(false),
})

export type CliArgs = {
  help: boolean
  since: string | undefined
  until: string | undefined
  sourceFilters: SourceFilter[]
}

export function parseCliArgs(argv: string[]): CliArgs | CliError {
  const parsed = errore.try({
    try: () =>
      parseArgs({
        args: argv,
        options: {
          since: { type: 'string' },
          until: { type: 'string' },
          source: { type: 'string', multiple: true, short: 's' },
          help: { type: 'boolean', short: 'h' },
        },
        strict: true,
        allowPositionals: true,
      }),
    catch: (e) =>
      new CliError({
        reason: e instanceof Error ? e.message : String(e),
        cause: e,
      }),
  })
  if (parsed instanceof Error) return parsed

  if (parsed.values.help === true) {
    return { help: true, since: undefined, until: undefined, sourceFilters: [] }
  }

  const values = cliValuesSchema.safeParse(parsed.values)
  if (!values.success) {
    return new CliError({
      reason: z.prettifyError(values.error),
      cause: values.error,
    })
  }

  return {
    help: values.data.help,
    since: values.data.since,
    until: values.data.until,
    sourceFilters: values.data.source,
  }
}

function matches(
  filter: SourceFilter,
  entry: { transport: Transport; source: { source: string } },
): boolean {
  if (entry.source.source !== filter.name) return false
  return filter.transport === null || filter.transport === entry.transport
}

export function applySourceFilters<S extends { source: string }>(opts: {
  filters: ReadonlyArray<SourceFilter>
  sources: ReadonlyArray<{ transport: Transport; source: S }>
}): S[] | CliError {
  if (opts.filters.length === 0) return opts.sources.map((e) => e.source)

  for (const filter of opts.filters) {
    if (!opts.sources.some((entry) => matches(filter, entry))) {
      return new CliError({
        reason: `--source ${filter.raw} matches no configured source`,
      })
    }
  }

  return opts.sources
    .filter((entry) => opts.filters.some((filter) => matches(filter, entry)))
    .map((entry) => entry.source)
}
