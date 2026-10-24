import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseAllDocuments } from 'yaml'

const root = new URL('../', import.meta.url)

function overridesIn(file: string): Record<string, string> | undefined {
  return parseAllDocuments(readFileSync(new URL(file, root), 'utf8'))
    .map(document => (document.toJS() as { overrides?: Record<string, string> } | null)?.overrides)
    .find(overrides => overrides !== undefined)
}

const workspaceOverrides = overridesIn('pnpm-workspace.yaml') ?? {}
const EXACT_VERSION = /^\d+\.\d+\.\d+$/
const SAME_MAJOR_FLOOR = /^\^\d+\.\d+\.\d+$/

describe('dependency overrides', () => {
  it('every override that lifts a floor keeps its major', () => {
    const unbounded = Object.entries(workspaceOverrides)
      .filter(([, range]) => !EXACT_VERSION.test(range) && !SAME_MAJOR_FLOOR.test(range))
    expect(unbounded).toEqual([])
  })

  it('the lockfile records the overrides the workspace declares', () => {
    expect(overridesIn('pnpm-lock.yaml')).toEqual(workspaceOverrides)
  })
})
