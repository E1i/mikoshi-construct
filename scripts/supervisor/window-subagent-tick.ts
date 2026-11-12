import type { DatabaseSync } from 'node:sqlite'
import { hookSubagentsIn, recordWindowSubagent, windowSubagentKey } from '../window/window-subagents.js'

function atOf(at: string | null, now: Date): Date {
  const parsed = at === null ? Number.NaN : Date.parse(at)
  return Number.isNaN(parsed) ? now : new Date(parsed)
}

export class WindowSubagentTick {
  private readonly published = new Set<string>()

  constructor(private readonly db: DatabaseSync, private readonly root: string, private readonly now: () => number, private readonly prefix: string) {}

  step(): string[] {
    try {
      const now = new Date(this.now())
      let recorded = 0
      for (const { subagent, at } of hookSubagentsIn(this.root)) {
        const key = windowSubagentKey(subagent)
        if (this.published.has(key))
          continue
        if (recordWindowSubagent(this.db, subagent, atOf(at, now)))
          recorded += 1
        this.published.add(key)
      }
      return recorded === 0 ? [] : [`${this.prefix}published ${recorded} window subagent start/stop line(s) from the window agents file to the bus`]
    }
    catch (error) {
      return [`${this.prefix}publishing the window subagents from the window agents file failed: ${error instanceof Error ? error.message : String(error)}; retried on the next tick`]
    }
  }
}
