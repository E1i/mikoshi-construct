export function parseEverySeconds(raw: string): number {
  if (!/^\d+$/.test(raw) || Number(raw) < 1)
    throw new Error(`--every must be a whole number of seconds of at least 1, got '${raw}'`)
  return Number(raw)
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
