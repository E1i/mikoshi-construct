export const MINIMUM_SAMPLE = 5
export const RECENT_RUNS = 20

export type Band
  = | { kind: 'band', median: number, p25: number, p75: number, n: number }
    | { kind: 'none', n: number }

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

export function quantile(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  const position = (sorted.length - 1) * q
  const below = Math.floor(position)
  const above = Math.ceil(position)
  return sorted[below] + (sorted[above] - sorted[below]) * (position - below)
}

export function recentBand(oldestFirst: number[]): Band {
  const recent = oldestFirst.slice(-RECENT_RUNS)
  if (recent.length < MINIMUM_SAMPLE)
    return { kind: 'none', n: recent.length }
  return { kind: 'band', median: median(recent), p25: quantile(recent, 0.25), p75: quantile(recent, 0.75), n: recent.length }
}
