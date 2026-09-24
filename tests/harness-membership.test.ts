import { describe, expect, it } from 'vitest'
import { onTheHarnessRoute, packageScripts, reachedByHarness } from './package-scripts.js'

const OUTSIDE_THE_HARNESS: Record<string, string> = {
  'bench:architect': 'a benchmark run on demand, not a verdict on a change',
  'build': 'produces the package rather than judging it',
  'changeset': 'an authoring tool',
  'composition:render': 'a writer; composition:check is its gate',
  'contract:bump': 'a gate, deliberately outside: it needs the release tags and full history, so it runs in its own CI job with fetch-depth 0',
  'contract:update': 'a writer; tests/contract/surface.test.ts is its gate',
  'dev': 'runs the CLI from source',
  'docs:dev': 'a local server',
  'docs:preview': 'a local server',
  'lint:fix': 'a fixer; lint is its gate',
  'model:render': 'a writer; model:check is its gate',
  'prepublishOnly': 'a packaging hook',
  'release': 'publishes',
  'release-notes:render': 'a writer; the release index tests are its gate',
  'release:verify': 'a gate, deliberately outside: it inspects what was published, which does not exist when the harness runs',
  'test:watch': 'a local loop over the same tests',
  'version-packages': 'the version step; the release index tests gate its output',
}

describe('every gate is reachable from the harness, and anything outside it says why', () => {
  it('reaches a harness chain with more than one script in it, so the partition is not over nothing', () => {
    expect(reachedByHarness().size).toBeGreaterThan(3)
    expect(reachedByHarness()).toContain('quality')
  })

  it('classifies every script as reached by the harness or declared outside it with a reason', () => {
    const inside = onTheHarnessRoute()
    const unclassified = Object.keys(packageScripts()).filter(name => !inside.has(name) && !(name in OUTSIDE_THE_HARNESS))
    expect(unclassified).toEqual([])
  })

  it('goes red for a gate lifted out of the harness, which is how a correct check ends up off the route', () => {
    const lifted = { ...packageScripts(), quality: packageScripts().quality.replace(' && pnpm docs:anchors', '') }
    const inside = onTheHarnessRoute(lifted)
    expect(inside.has('docs:anchors')).toBe(false)
    expect(Object.keys(lifted).filter(name => !inside.has(name) && !(name in OUTSIDE_THE_HARNESS))).toContain('docs:anchors')
  })
})
