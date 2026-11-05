import type { ClientAdapter } from './contract.js'
import { claudeAdapter } from './claude/adapter.js'

export function clientAdapter(): ClientAdapter {
  return claudeAdapter
}
