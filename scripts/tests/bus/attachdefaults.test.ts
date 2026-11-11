import type { MergeBench } from './merge-bench.js'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runInit } from '../../../src/commands/init.js'
import { createUi, silentWriter } from '../../../src/ui/console.js'
import { resolveTheme } from '../../../src/ui/theme.js'
import { dryRunIn, keepDryRun } from '../../nodes/review/dry-run-record.js'
import { decisionsAdder } from '../../policy/decisions/projection.js'
import { decisionsInForceAt } from '../../policy/shards.js'
import { ALLOW_MERGE_RECORD, allowMergeRuleInForce, requestFromWindow, WindowRequests } from '../../window/window-requests.js'
import { sha } from './github-fake.js'
import { liveBench, spendReviewRounds } from './merge-bench.js'

const PR = 980
const CARD = PR + 100
const HEAD = sha('a')
const DRY_RUN = 'reviewer-dry'
const ui = createUi(resolveTheme({ plain: true }), silentWriter)
const roots: string[] = []
const benches: MergeBench[] = []

afterEach(() => {
  for (const bench of benches.splice(0))
    bench.close()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function scratch(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  roots.push(dir)
  return dir
}

async function initialised(): Promise<string> {
  const repository = scratch('attachdefaults-repo-')
  await runInit(ui, { dir: repository, preset: 'node-library', name: 'attachdefaults-fixture', yes: true, dryRun: false })
  return repository
}

function roundLimited(bus: string): MergeBench {
  const bench = liveBench()
  benches.push(bench)
  bench.gitHub.open({ number: PR, head: HEAD, review: 'failure' })
  spendReviewRounds(bench, PR, HEAD)
  mkdirSync(path.join(bus, 'dry-run-reviews'), { recursive: true })
  writeFileSync(path.join(bus, 'owner-decisions.md'), '# Owner decisions\n\n')
  keepDryRun(path.join(bus, 'dry-run-reviews'))(DRY_RUN, { pr: PR, head: HEAD })
  bench.tick()
  return bench
}

function requestsIn(bench: MergeBench, bus: string, repository: string): WindowRequests {
  const refuse = (): never => {
    throw new Error('not expected')
  }
  return new WindowRequests(bench.db, bench.clock.now, {
    treeOf: refuse,
    exists: refuse,
    cutTree: refuse,
    dryRunOf: dryRunIn(path.join(bus, 'dry-run-reviews')),
    addDecision: decisionsAdder(bench.db, path.join(bus, 'owner-decisions.md'), bench.clock.now),
    causeHolds: refuse,
    closePr: refuse,
    closeDropped: () => [],
  }, path.join(bus, 'owner-answers'), () => null, repository)
}

describe('the window allow-merge rule travels with the construct, not with a decision number', () => {
  it('init materializes the window allow-merge decision record', async () => {
    const repository = await initialised()
    const record = path.join(repository, ALLOW_MERGE_RECORD)

    expect(existsSync(record)).toBe(true)
    expect(readFileSync(record, 'utf8')).toMatch(/^Status: accepted$/m)
    expect(allowMergeRuleInForce(repository)).toBe(true)
  })

  it('allow-merge is granted in a repository whose decisions carry the materialized rule and no D-186', async () => {
    const repository = await initialised()
    const bus = scratch('attachdefaults-bus-')
    const bench = roundLimited(bus)
    expect(decisionsInForceAt(bench.db, bench.clock.now()).map(decision => decision.decisionId)).not.toContain(186)

    const request = requestFromWindow(bench.db, bench.clock.now().toISOString(), 'window-1', { kind: 'allow-merge', pr: PR, head: HEAD, dry_run: DRY_RUN })
    expect(requestsIn(bench, bus, repository).run()[0]).toMatchObject({ kind: 'done', request })
    expect(readFileSync(path.join(bus, 'owner-decisions.md'), 'utf8')).toContain(`[owner] allow-merge PR #${PR} at ${HEAD} · by ${ALLOW_MERGE_RECORD} · card #${CARD}`)
  })

  it('allow-merge is refused in a repository that withdrew the materialized rule', async () => {
    const repository = await initialised()
    const record = path.join(repository, ALLOW_MERGE_RECORD)
    writeFileSync(record, readFileSync(record, 'utf8').replace('Status: accepted', 'Status: withdrawn'))
    const bus = scratch('attachdefaults-bus-')
    const bench = roundLimited(bus)

    const request = requestFromWindow(bench.db, bench.clock.now().toISOString(), 'window-1', { kind: 'allow-merge', pr: PR, head: HEAD, dry_run: DRY_RUN })
    expect(requestsIn(bench, bus, repository).run()).toEqual([{ kind: 'refused', request, detail: `${ALLOW_MERGE_RECORD} is not in force in ${repository}: absent, or its status is not accepted` }])
  })
})
