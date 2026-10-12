const POLL_MS = 25

export async function waitFor(ready: () => boolean, awaited: () => string, deadlineMs: number): Promise<void> {
  const started = Date.now()
  while (!ready()) {
    const waited = Date.now() - started
    if (waited >= deadlineMs)
      throw new Error(`waited ${waited}ms for ${awaited()}, and it never came`)
    await new Promise(resolve => setTimeout(resolve, POLL_MS))
  }
}
