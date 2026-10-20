import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { GH_PORT, ghCallers, knownCallers, repositoryScripts, spawnsGh, staleCallers, unrecordedCallers } from '../../core/gh-callers.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..')

describe('gh is spawned through one port, and every other spawn is recorded', () => {
  const sources = repositoryScripts(REPO_ROOT)
  const found = ghCallers(sources)
  const known = knownCallers(REPO_ROOT)

  it('gh spawned outside the port is exactly the recorded baseline', () => {
    expect(unrecordedCallers(found, known)).toEqual([])
    expect(staleCallers(found, known)).toEqual([])
    expect(known).toEqual([...known].sort())
    expect(sources.has(GH_PORT)).toBe(true)
    expect(found).not.toContain(GH_PORT)
    expect(found).not.toContain('scripts/bus/github.ts')
  })

  it('a new spawn of gh outside the port fails', () => {
    const sneaking = new Map(sources)
    sneaking.set('scripts/bus/sneak.ts', `import { execFileSync } from 'node:child_process'\nexport const sneak = () => execFileSync('gh', ['pr', 'list'])\n`)
    expect(unrecordedCallers(ghCallers(sneaking), known)).toEqual(['scripts/bus/sneak.ts'])
  })

  it('a file that names gh without spawning anything, or spawns something else, is no caller', () => {
    expect(spawnsGh('a.ts', `export const tokens = ['gh', 'pr']\n`)).toBe(false)
    expect(spawnsGh('b.ts', `import { execFileSync } from 'node:child_process'\nexecFileSync('git', ['status'])\nthrow new Error('gh unavailable')\n`)).toBe(false)
    expect(spawnsGh('c.ts', `import { spawnSync } from 'node:child_process'\nexport function api(command = 'gh') { return spawnSync(command, []) }\n`)).toBe(true)
  })

  it('a recorded caller that no longer spawns gh fails, so the list only shrinks', () => {
    const gone = 'scripts/bus/retired.ts'
    expect(staleCallers(found, [...known, gone])).toEqual([gone])
    const migrated = new Map(sources)
    migrated.set(known[0]!, `export const migrated = true\n`)
    expect(staleCallers(ghCallers(migrated), known)).toEqual([known[0]])
  })
})
