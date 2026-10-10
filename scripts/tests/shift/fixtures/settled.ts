import { existsSync, readFileSync } from 'node:fs'

const POLL_MS = 25

function completeLine(file: string): string | undefined {
  if (!existsSync(file))
    return undefined
  const text = readFileSync(file, 'utf8')
  return text.endsWith('\n') && text.trim() !== '' ? text.trim() : undefined
}

export async function settled(file: string, timeoutMs = 20_000): Promise<string> {
  const started = Date.now()
  for (;;) {
    const line = completeLine(file)
    if (line !== undefined)
      return line
    const waited = Date.now() - started
    if (waited >= timeoutMs)
      throw new Error(`${file} did not settle into a complete non-empty line within ${waited}ms`)
    await new Promise(resolve => setTimeout(resolve, POLL_MS))
  }
}
