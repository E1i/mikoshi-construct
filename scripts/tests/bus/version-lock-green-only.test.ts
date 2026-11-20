import type { MergeBench } from './merge-bench.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { textSha } from '../../../src/card/text-sha.js'
import { appendEvent } from '../../core/db.js'
import { CARD_ADMITTED } from '../../core/events.js'
import { MAIN_2, sha } from './github-fake.js'
import { eventsOf, liveBench } from './merge-bench.js'

const VERSION_PR = 981
const VERSION_REF = 'changeset-release/main'
const APPROVED = [{ status: 'completed' as const, conclusion: 'success' as const }]

const benches: MergeBench[] = []

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const bench of benches.splice(0))
    bench.close()
})

function bench(): MergeBench {
  const made = liveBench()
  benches.push(made)
  return made
}

function admittedNaming(made: MergeBench, cardId: number, prose: string): void {
  const text = `card: #${cardId} card-${cardId} [implement/netwatch/S/cheap/auto] · depends — · blocks —\nbranch: feat/card-${cardId}\ntouches: scripts/a.ts\ncontinue: stop\nwho: shift\n\n${prose}\n`
  appendEvent(made.db, { ts: made.clock.now().toISOString(), type: CARD_ADMITTED, actor: 'worker:intake:by-hand', cardId, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:body:${cardId}`, payload: { card: `#${cardId}`, lane: 'lane-1', text, textSha: textSha(text) }, legacy: false })
}

describe('the version lock holds only a green version pull request', () => {
  it('a red version pull request does not lock main', () => {
    const made = bench()
    made.gitHub.open({ number: 980, review: 'success' })
    made.gitHub.open({ number: VERSION_PR, head: sha('c'), ref: VERSION_REF, runs: APPROVED, required: 'failure' })
    made.tick()

    expect(made.merge(made.lease()!)).toMatchObject({ kind: 'merged', commit: MAIN_2 })
    expect(eventsOf(made.db, 'policy.denied')).toEqual([])
  })

  it('a version pull request whose CI is still pending does not lock main', () => {
    const made = bench()
    made.gitHub.open({ number: 980, review: 'success' })
    made.gitHub.open({ number: VERSION_PR, head: sha('c'), ref: VERSION_REF, runs: APPROVED, required: 'pending' })
    made.tick()

    expect(made.merge(made.lease()!)).toMatchObject({ kind: 'merged', commit: MAIN_2 })
    expect(eventsOf(made.db, 'policy.denied')).toEqual([])
  })

  it('a card where PR #<n> is glued to a preceding word does not name the version pull request', () => {
    const made = bench()
    admittedNaming(made, 1080, `A token like XPR #${VERSION_PR} is not a pull request reference.`)
    made.gitHub.open({ number: 980, review: 'success' })
    made.gitHub.open({ number: VERSION_PR, head: sha('c'), ref: VERSION_REF, runs: APPROVED })
    made.tick()

    expect(made.merge(made.lease()!)).toMatchObject({ kind: 'denied', denial: { kind: 'technical', reason: 'version_pr_open' }, next: 'queued' })
    expect(made.gitHub.puts).toEqual([])
  })

  it('a card that names the version pull request merges through the lock', () => {
    const made = bench()
    admittedNaming(made, 1080, `Repair the version pull request PR #${VERSION_PR} so its CI turns green.`)
    made.gitHub.open({ number: 980, review: 'success' })
    made.gitHub.open({ number: VERSION_PR, head: sha('c'), ref: VERSION_REF, runs: APPROVED })
    made.tick()

    expect(made.merge(made.lease()!)).toMatchObject({ kind: 'merged', commit: MAIN_2 })
    expect(eventsOf(made.db, 'policy.denied')).toEqual([])

    made.gitHub.pulls.get(VERSION_PR)!.head = sha('d')
    made.gitHub.open({ number: 982, review: 'success', head: sha('e') })
    made.tick()
    expect(made.merge(made.lease()!)).toMatchObject({ kind: 'denied', denial: { kind: 'technical', reason: 'version_pr_open' }, next: 'queued' })
  })

  it('a green version pull request still locks every other merge', () => {
    const made = bench()
    admittedNaming(made, 1080, `Names another pull request, PR #${VERSION_PR}0, not the version one.`)
    made.gitHub.open({ number: 980, review: 'success' })
    made.gitHub.open({ number: VERSION_PR, head: sha('c'), ref: VERSION_REF, runs: APPROVED })
    made.tick()

    expect(made.merge(made.lease()!)).toMatchObject({ kind: 'denied', denial: { kind: 'technical', reason: 'version_pr_open' }, next: 'queued' })
    expect(made.gitHub.puts).toEqual([])
  })
})
