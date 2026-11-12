import type { CheckCatalog } from '../../ci/card-runs.js'
import type { MergeBench } from './merge-bench.js'
import { afterEach, describe, expect, it } from 'vitest'
import { textSha } from '../../../src/card/text-sha.js'
import { appendEvent } from '../../core/db.js'
import { CARD_ADMITTED, SCOPE_WIDENED } from '../../core/events.js'
import { reduce } from '../../core/reducer.js'
import { cardContract } from '../../intake/card-contract.js'
import { busCardBodies } from '../../intake/parking-reads.js'
import { busWidenedPaths, gitDepthSources } from '../../nodes/review/depth-sources.js'
import { planReview } from '../../nodes/review/review-depth.js'
import { mergeBench } from './merge-bench.js'

const CARD = 1778
const TOUCHED = 'src/a.ts'
const WIDENED = 'scripts/window/window-requests.ts'
const CHANGED = [TOUCHED, WIDENED]
const EMPTY: CheckCatalog = { testLayers: new Map(), moduleLayers: new Map() }

const benches: MergeBench[] = []

afterEach(() => {
  for (const made of benches.splice(0))
    made.close()
})

function body(generation: string): string {
  return `card: #${CARD} widened [implement/netwatch/S/cheap/auto] · depends — · blocks —\nbranch: feat/widened\ntouches: ${TOUCHED}\ncontinue: stop\nwho: shift\n\nDo it, ${generation}.\n`
}

function admit(made: MergeBench, generation: string): void {
  const text = body(generation)
  appendEvent(made.db, { ts: made.clock.now().toISOString(), type: CARD_ADMITTED, actor: 'worker:intake:window', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${CARD}:${generation}`, payload: { card: `#${CARD}`, lane: 'lane-a', decision: 'auto', contour: 'cheap', depends: [], admission: `admission-${generation}`, text, textSha: textSha(text), bodySha: generation }, legacy: false })
  reduce(made.db)
}

function widen(made: MergeBench): void {
  const admission = cardContract(made.db, CARD)!.admissionEventId
  appendEvent(made.db, { ts: made.clock.now().toISOString(), type: SCOPE_WIDENED, actor: 'worker:answer:worker-1', cardId: CARD, pr: null, head: null, dedupeKey: `${SCOPE_WIDENED}:${CARD}:${admission}`, payload: { paths: [WIDENED], admission, detail: 'in the concept of the card' }, legacy: false })
}

function touchFindings(made: MergeBench): string[] {
  const sources = {
    ...gitDepthSources('/nowhere', '/nowhere/morse.jsonl', busCardBodies(made.busPath), () => '', () => EMPTY, busWidenedPaths(made.busPath)),
    base: () => 'base',
    predict: (task: string, base: string, head: string) => ({ prediction: { task, base, head, verdict: 'cheap' as const, rule: 'docs-only' as const, why: CHANGED }, files: CHANGED, added: [] }),
  }
  const plan = planReview({ taskKey: `review:${CARD}:1560:x`, queue: 'review', cardId: CARD, pr: 1560, head: 'head', leaseGen: 1, actor: 'worker:review:x' }, null, sources)
  return plan.depth === 'diff' && plan.round === 'first' ? plan.touchFindings : [`the plan is ${plan.depth}`]
}

function bench(): MergeBench {
  const made = mergeBench()
  benches.push(made)
  return made
}

describe('the review reads the scope the answer node widened', () => {
  it('a path the answer node widened for the latest admission is inside the review touches', () => {
    const made = bench()
    admit(made, 'first')
    expect(touchFindings(made)).toEqual([expect.stringContaining(`${WIDENED} is outside the touches of card #${CARD}`)])

    widen(made)

    expect(touchFindings(made)).toEqual([])
  })

  it('a path widened for an earlier admission is still outside the touches', () => {
    const made = bench()
    admit(made, 'first')
    widen(made)
    admit(made, 'second')

    expect(busWidenedPaths(made.busPath)(CARD)).toEqual([])
    expect(touchFindings(made)).toEqual([expect.stringContaining(`${WIDENED} is outside the touches of card #${CARD}`)])
  })

  it('a bus that does not exist widens nothing', () => {
    expect(busWidenedPaths('/nowhere/bus.db')(CARD)).toEqual([])
  })
})
