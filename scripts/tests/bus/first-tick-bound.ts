export const FIRST_TICK_SLACK_MS = 5

export function median(values: number[]): number {
  return [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!
}

export function firstTickBound(usual: number[]): number {
  const usualMedian = median(usual)
  return Math.max(2 * usualMedian, usualMedian + FIRST_TICK_SLACK_MS)
}
