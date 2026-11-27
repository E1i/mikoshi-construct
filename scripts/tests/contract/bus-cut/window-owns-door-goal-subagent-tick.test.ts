import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, it } from 'vitest'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..')
const WINDOW_FILES = ['scripts/policy/decisions/window-door.ts', 'src/commands/board/goal.ts', 'scripts/supervisor/window-subagent-tick.ts'] as const
const GONE_ROWS = ['boundary:decisions->window', 'boundary:window->board'] as const

function jsonAt<T>(file: string): T {
  return JSON.parse(readFileSync(path.join(REPO_ROOT, file), 'utf8')) as T
}

it('window declares the door, the goal and the subagent tick, and decisions->window and window->board are gone', () => {
  const { paths } = jsonAt<{ paths: string[] }>('declarations/modules/window.json')
  expect(WINDOW_FILES.filter(file => !paths.includes(file))).toEqual([])
  const rows = Object.keys(jsonAt<Record<string, number>>('contract/ratchet.json'))
  expect(GONE_ROWS.filter(row => rows.includes(row))).toEqual([])
})
