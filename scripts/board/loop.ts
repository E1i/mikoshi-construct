import type { BoardResult } from './run.js'
import { frameText } from './frame.js'

export interface LoopDeps {
  draw: (now: Date) => BoardResult
  now: () => Date
  sleep: (ms: number) => Promise<void>
  isTTY: boolean
  out: (text: string) => void
  err: (text: string) => void
  writeFrame: (file: string, lines: string[]) => void
}

export async function runBoardLoop(deps: LoopDeps): Promise<number> {
  for (;;) {
    const result = deps.draw(deps.now())
    for (const line of result.stderr)
      deps.err(`${line}\n`)
    const clear = result.everySeconds !== undefined && deps.isTTY
    if (result.stdout.length > 0)
      deps.out(frameText(result.stdout, clear))
    if (result.frameFile !== undefined)
      deps.writeFrame(result.frameFile, result.stdout)
    if (result.everySeconds === undefined)
      return result.exitCode
    await deps.sleep(result.everySeconds * 1000)
  }
}
