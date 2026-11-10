export const POLL_MS = 25

export interface WaitClock {
  now: () => number
  setTimeout: (run: () => void, ms: number) => unknown
}

export const SYSTEM_CLOCK: WaitClock = { now: () => Date.now(), setTimeout }

export async function waitFor(ready: () => boolean, awaited: () => string, deadlineMs: number, clock: WaitClock = SYSTEM_CLOCK): Promise<void> {
  const started = clock.now()
  while (!ready()) {
    const waited = clock.now() - started
    if (waited >= deadlineMs)
      throw new Error(`waited ${waited}ms for ${awaited()}, and it never came`)
    await new Promise<void>((resolve) => {
      clock.setTimeout(resolve, POLL_MS)
    })
  }
}
