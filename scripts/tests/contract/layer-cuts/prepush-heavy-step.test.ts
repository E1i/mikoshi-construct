import type { Run } from '../../../ci/layers.js'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { throughQueue } from '../../../ci/prepush.js'

const REPO = path.resolve(import.meta.dirname, '../../../..')
const PREPUSH = 'scripts/ci/prepush.ts'
const LOCK_IMPORT = /from '[^']*quality\/lock\.js'/
const ENTRY_GUARD = /^if \(process\.argv\[1\] === import\.meta\.filename\)/
const FULL_RUN: Run = { kind: 'full', why: 'fixture' }
const LAYER_RUN: Run = { kind: 'layers', layers: [], tests: [] }
const QUEUED = 3
const DIRECT = 4

function sourceLines(): string[] {
  return readFileSync(path.join(REPO, PREPUSH), 'utf8').split('\n')
}

describe('throughQueue takes the machine lock from the pre-push entry, not from a default', () => {
  it('throughQueue declares no default queue', () => {
    expect(throughQueue.length).toBe(3)
    const declaration = sourceLines().find(line => line.startsWith('export function throughQueue('))
    expect(declaration).toBeDefined()
    expect(declaration).not.toContain('heavyStep')
    expect(declaration).not.toMatch(/queue[^,)]*=/)
  })

  it('heavyStep is named only in the entry block of prepush.ts', () => {
    const lines = sourceLines()
    const guard = lines.findIndex(line => ENTRY_GUARD.test(line))
    expect(guard).toBeGreaterThan(0)
    const named = lines.flatMap((line, at) => /\bheavyStep\b/.test(line) && !LOCK_IMPORT.test(line) ? [at] : [])
    expect(named.length).toBeGreaterThan(0)
    expect(named.filter(at => at < guard)).toEqual([])
  })

  it('a full run goes through the queue it is given, a layered run does not', async () => {
    const queued: string[] = []
    const queue = async (step: () => Promise<number>): Promise<number> => {
      queued.push('queued')
      return step()
    }
    expect(await throughQueue(FULL_RUN, async () => QUEUED, queue)).toBe(QUEUED)
    expect(await throughQueue(LAYER_RUN, async () => DIRECT, queue)).toBe(DIRECT)
    expect(queued).toEqual(['queued'])
  })
})
