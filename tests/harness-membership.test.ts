import { describe, expect, it } from 'vitest'
import { onTheHarnessRoute, packageScripts, reachedByHarness } from './package-scripts.js'

const OUTSIDE_THE_HARNESS: Record<string, string> = {
  'approve': 'lists the owner\'s approval queue and writes or revokes an approval when run by hand; its own tests are its gate',
  'bench:architect': 'a benchmark run on demand, not a verdict on a change',
  'board': 'a read-only view of the Ghost tasks from the handoff records, not a verdict on a change',
  'build': 'produces the package rather than judging it',
  'changeset': 'an authoring tool',
  'composition:render': 'a writer; composition:check is its gate',
  'contract:bump': 'a gate, deliberately outside: it needs the release tags and full history, so it runs in its own CI job with fetch-depth 0',
  'contract:update': 'a writer; tests/contract/surface.test.ts is its gate',
  'dev': 'runs the CLI from source',
  'done:check': 'a step a reviewer runs on a finished ladder run; its own tests are its gate',
  'ghosts:cleanup': 'removes a merged task\'s worktree and quality logs when run by hand; its own tests are its gate',
  'ghosts:expect-sample': 'a read-only forecast printed by hand; its own tests are its gate',
  'task:start': 'cuts a task\'s worktree from its card and writes its journal start line when run by hand; its own tests are its gate',
  'task:close': 'appends a task\'s closing journal line when run by hand; its own tests are its gate',
  'shift': 'runs a shift of headless sessions when run by hand; its own tests, on a claude stub, are its gate',
  'shift:merge': 'arms auto-merge on a shift task\'s pull request when run by hand; its own tests, on a gh stub, are its gate',
  'shift:report': 'prints the table of a shift that ran; its own tests are its gate',
  'ghosts:hash': 'a hand-run tool for computing an approval hash; its own tests are its gate',
  'ghosts:launch': 'opens headless sessions after a human confirmation; its own tests are its gate',
  'ghosts:verdict': 'appends one journal line after a review verdict file holds its schema and its digests; its own tests are its gate',
  'ghosts:watch': 'a read-only view of running sessions, not a verdict on a change',
  'docs:dev': 'a local server',
  'docs:preview': 'a local server',
  'lint:fix': 'a fixer; lint is its gate',
  'model:render': 'a writer; model:check is its gate',
  'prepublishOnly': 'a packaging hook',
  'release': 'publishes',
  'release-notes:render': 'a writer; the release index tests are its gate',
  'release:evidence': 'a read-only report on merged cards from the journal, not a verdict on a change',
  'release:verify': 'a gate, deliberately outside: it inspects what was published, which does not exist when the harness runs',
  'task:merged': 'appends merge lines to the journal from gh pr view; its own tests are its gate',
  'test:watch': 'a local loop over the same tests',
  'test:weights': 'rewrites the table CI balances its vitest shards by; it changes how the tests are split, not whether they pass',
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
