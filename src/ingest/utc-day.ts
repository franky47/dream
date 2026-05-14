const DAY_MS = 24 * 60 * 60 * 1000

export function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function floorToUtcDay(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
}

export function daysInRange(since: Date, until: Date): string[] {
  if (since.getTime() >= until.getTime()) return []
  const firstDay = floorToUtcDay(since)
  const lastDay = floorToUtcDay(new Date(until.getTime() - 1))
  const days: string[] = []
  for (let ms = firstDay; ms <= lastDay; ms += DAY_MS) {
    days.push(utcDay(new Date(ms)))
  }
  return days
}
