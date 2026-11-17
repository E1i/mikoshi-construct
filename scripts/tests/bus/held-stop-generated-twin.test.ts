import type { MergeBench } from './merge-bench.js'
import { afterEach, describe, expect, it } from 'vitest'
import { textSha } from '../../../src/card/text-sha.js'
import { appendEvent } from '../../core/db.js'
import { CARD_ADMITTED, CARD_STOPPED, OUTSIDE_TOUCHES, QUESTION_AGENT } from '../../core/events.js'
import { GENERATED_FILES } from '../../core/factory-paths.js'
import { heldSessionStop } from '../../nodes/launch/launch-worker.js'
import { mergeBench } from './merge-bench.js'

const CARD = 1967
const TOUCHED = 'scripts/a.ts'
const FACTORY_TWIN = GENERATED_FILES.factory.path
const REAL_OUTSIDE = 'scripts/x.ts'

const benches: MergeBench[] = []

afterEach(() => {
  for (const bench of benches.splice(0))
    bench.close()
})

function stoppedNaming(paths: string[]): MergeBench {
  const made = mergeBench()
  benches.push(made)
  const text = `card: #${CARD} a-card [implement/construct/S/cheap/auto] · depends — · blocks —\nbranch: feat/card-${CARD}\ntouches: ${TOUCHED}\ncontinue: auto\nwho: shift\n\nDo it.\n`
  appendEvent(made.db, { ts: made.clock.now().toISOString(), type: CARD_ADMITTED, actor: 'worker:intake:by-hand', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${CARD}`, payload: { card: `#${CARD}`, lane: 'lane-1', decision: 'auto', contour: 'cheap', depends: [], admission: `admission-${CARD}`, text, textSha: textSha(text) }, legacy: false })
  made.tick()
  appendEvent(made.db, { ts: made.clock.now().toISOString(), type: CARD_STOPPED, actor: 'worker:launch:launch-1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STOPPED}:${CARD}`, payload: { reason: QUESTION_AGENT, detail: `the touches do not cover ${paths.join(', ')}`, code: OUTSIDE_TOUCHES, paths }, legacy: false })
  made.tick()
  return made
}

describe('a generated twin named by an outside-touches stop counts as covered', () => {
  it('an outside-touches stop naming only the factory twin does not hold launch', () => {
    expect(heldSessionStop(stoppedNaming([FACTORY_TWIN]).db, CARD)).toBeNull()
  })

  it('the factory twin beside a real outside path still holds launch on that path only', () => {
    expect(heldSessionStop(stoppedNaming([FACTORY_TWIN, REAL_OUTSIDE]).db, CARD)).toMatchObject({ code: OUTSIDE_TOUCHES, paths: [REAL_OUTSIDE] })
  })
})
