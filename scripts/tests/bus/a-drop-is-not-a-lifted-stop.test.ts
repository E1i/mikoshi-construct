import type { MergeBench } from './merge-bench.js'
import { afterEach, describe, expect, it } from 'vitest'
import { appendEvent, closeOwnerWait, openOwnerWait } from '../../core/db.js'
import { CARD_ADMITTED, CARD_CLOSED, CARD_DROPPED, CARD_STOPPED } from '../../core/events.js'
import { LAUNCH_STOP_WITH_NO_PULL_REQUEST, LIFTED_ADMISSION } from '../../core/queue.js'
import { eventsOf, mergeBench } from './merge-bench.js'

const CARD = 1886

const benches: MergeBench[] = []

afterEach(() => {
  for (const made of benches.splice(0))
    made.close()
})

function at(made: MergeBench): string {
  return made.clock.now().toISOString()
}

function stoppedOnAQuestionThatIsAsked(): { made: MergeBench, wait: string } {
  const made = mergeBench()
  benches.push(made)
  appendEvent(made.db, { ts: at(made), type: CARD_ADMITTED, actor: 'worker:intake:window', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${CARD}`, payload: { lane: 'lane-a', decision: 'auto', contour: 'cheap', depends: [], admission: `admission-${CARD}` }, legacy: false })
  appendEvent(made.db, { ts: at(made), type: CARD_STOPPED, actor: 'worker:launch:launch-1', cardId: CARD, pr: null, head: null, dedupeKey: `${LAUNCH_STOP_WITH_NO_PULL_REQUEST}${CARD}`, payload: { reason: 'question.agent', detail: `card #${CARD} asks`, widen: [] }, legacy: false })
  const wait = openOwnerWait(made.db, at(made), 'worker:launch:launch-1', { need: 'decision', text: `card #${CARD} asks`, command: `pnpm decide ${CARD}`, card: CARD })
  made.tick()
  return { made, wait }
}

function admissions(made: MergeBench): unknown[] {
  return eventsOf(made.db, CARD_ADMITTED).map(payload => payload.admission)
}

describe('a card that ended after its question stop is not re-admitted as lifted', () => {
  it('a card dropped after a question stop gets no lifted card.admitted when the drop closes its wait', () => {
    const { made } = stoppedOnAQuestionThatIsAsked()
    appendEvent(made.db, { ts: at(made), type: CARD_DROPPED, actor: 'worker:intake:window', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_DROPPED}:${CARD}`, payload: { lane: 'dropped', reason: 'superseded' }, legacy: false })
    made.tick()
    made.tick()

    expect(admissions(made)).toEqual([`admission-${CARD}`])
  })

  it('a card closed after a question stop gets no lifted card.admitted', () => {
    const { made } = stoppedOnAQuestionThatIsAsked()
    appendEvent(made.db, { ts: at(made), type: CARD_CLOSED, actor: 'worker:close:s1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_CLOSED}:${CARD}`, payload: { verification: 'measurement', report: 'report.md' }, legacy: false })
    made.tick()
    made.tick()

    expect(admissions(made)).toEqual([`admission-${CARD}`])
  })

  it('the positive control: closing the question of a card still in work lifts it', () => {
    const { made, wait } = stoppedOnAQuestionThatIsAsked()
    const stop = (made.db.prepare(`SELECT max(id) AS id FROM events WHERE type = '${CARD_STOPPED}'`).get() as { id: number }).id
    closeOwnerWait(made.db, at(made), 'owner', wait, 'go on', 1)
    made.tick()
    made.tick()

    expect(admissions(made)).toContain(`${LIFTED_ADMISSION}:${stop}`)
  })
})
