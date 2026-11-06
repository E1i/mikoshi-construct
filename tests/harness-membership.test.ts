import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { onTheHarnessRoute, packageScripts, reachedByHarness } from './package-scripts.js'

const MANIFEST = path.resolve(import.meta.dirname, '../package.json')
const OUTSIDE_THE_HARNESS = (JSON.parse(readFileSync(MANIFEST, 'utf8')) as { scriptsOutsideTheHarness: Record<string, string> }).scriptsOutsideTheHarness

describe('every gate is reachable from the harness, and anything outside it says why', () => {
  it('reaches a harness chain with more than one script in it, so the partition is not over nothing', () => {
    expect(reachedByHarness().size).toBeGreaterThan(3)
    expect(reachedByHarness()).toContain('quality')
  })

  it('runs the harness steps under scripts/quality/lock.ts, so two quality runs on one machine take turns', () => {
    expect(packageScripts().quality).toBe('node --import tsx scripts/quality/lock.ts node --import tsx scripts/scratch/run.ts pnpm run quality:steps')
    expect(reachedByHarness()).toContain('quality:steps')
  })

  it('classifies every script as reached by the harness or declared outside it with a reason', () => {
    const inside = onTheHarnessRoute()
    const unclassified = Object.keys(packageScripts()).filter(name => !inside.has(name) && !(name in OUTSIDE_THE_HARNESS))
    expect(unclassified).toEqual([])
  })

  it('goes red for a gate lifted out of the harness, which is how a correct check ends up off the route', () => {
    const lifted = { ...packageScripts(), 'quality:steps': packageScripts()['quality:steps'].replace(' && pnpm docs:anchors', '') }
    const inside = onTheHarnessRoute(lifted)
    expect(inside.has('docs:anchors')).toBe(false)
    expect(Object.keys(lifted).filter(name => !inside.has(name) && !(name in OUTSIDE_THE_HARNESS))).toContain('docs:anchors')
  })
})
