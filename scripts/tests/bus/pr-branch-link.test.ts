import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { textSha } from '../../../src/card/text-sha.js'
import { appendEvent, openBus } from '../../core/db.js'
import { CARD_ADMITTED } from '../../core/events.js'
import { reduce } from '../../core/reducer.js'
import { NetWatch } from '../../ports/netwatch.js'
import { busProjections } from '../../supervisor/composition.js'
import { Clock, FakeGitHub } from './github-fake.js'

const roots: string[] = []
const MARKERLESS = 'A pull request opened by hand, with no card line.'

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

type Bus = ReturnType<typeof openBus>

function bench(): { db: Bus, gitHub: FakeGitHub, netWatch: NetWatch } {
  const root = mkdtempSync(path.join(tmpdir(), 'bus-pr-branch-link-'))
  roots.push(root)
  const db = openBus(path.join(root, 'bus.db'))
  const gitHub = new FakeGitHub()
  return { db, gitHub, netWatch: new NetWatch(db, gitHub.client, new Clock().now) }
}

function admitBody(db: Bus, cardId: number, branch: string): void {
  const text = `card: #${cardId} a-card [implement/netwatch/S/cheap/auto] · depends — · blocks —\nbranch: ${branch}\ntouches: scripts/a.ts\ncontinue: stop\nwho: shift\n\nDo it.\n`
  appendEvent(db, { ts: '2026-11-04T09:00:00.000Z', type: CARD_ADMITTED, actor: 'worker:intake:by-hand', cardId, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:body:${cardId}`, payload: { card: `#${cardId}`, lane: 'lane-1', text, textSha: textSha(text), bodySha: textSha(text).slice(0, 12) }, legacy: false })
}

function observe(db: Bus, netWatch: NetWatch): void {
  reduce(db, 'pending', busProjections())
  netWatch.poll()
  reduce(db, 'pending', busProjections())
}

function prCard(db: Bus, pr: number): unknown {
  return (db.prepare('SELECT card_id FROM prs WHERE pr = ?').get(pr) as { card_id: number | null }).card_id
}

function cardPr(db: Bus, cardId: number): unknown {
  return (db.prepare('SELECT pr FROM cards WHERE card_id = ?').get(cardId) as { pr: number | null } | undefined)?.pr ?? null
}

describe('a pull request linked by its branch', () => {
  it('marker-less PR on a card branch gets the card', () => {
    const { db, gitHub, netWatch } = bench()
    admitBody(db, 1494, 'feat/registry-sync')
    gitHub.open({ number: 16, body: MARKERLESS, ref: 'feat/registry-sync' })
    observe(db, netWatch)
    expect(prCard(db, 16)).toBe(1494)
    expect(cardPr(db, 1494)).toBe(16)
    db.close()
  })

  it('unmatched branch stays unlinked', () => {
    const { db, gitHub, netWatch } = bench()
    admitBody(db, 1494, 'feat/registry-sync')
    admitBody(db, 1500, 'feat/shared')
    admitBody(db, 1501, 'feat/shared')
    gitHub.open({ number: 16, body: MARKERLESS, ref: 'feat/nobody' })
    gitHub.open({ number: 17, body: MARKERLESS, ref: 'feat/shared' })
    observe(db, netWatch)
    expect(prCard(db, 16)).toBeNull()
    expect(prCard(db, 17)).toBeNull()
    expect([cardPr(db, 1494), cardPr(db, 1500), cardPr(db, 1501)]).toEqual([null, null, null])
    db.close()
  })

  it('marker wins over branch', () => {
    const { db, gitHub, netWatch } = bench()
    admitBody(db, 1494, 'feat/registry-sync')
    admitBody(db, 1600, 'feat/other')
    gitHub.open({ number: 16, body: '#1600 other [implement/netwatch/S/cheap/auto] · depends — · blocks —', ref: 'feat/registry-sync' })
    observe(db, netWatch)
    expect(prCard(db, 16)).toBe(1600)
    expect(cardPr(db, 1600)).toBe(16)
    expect(cardPr(db, 1494)).toBeNull()
    db.close()
  })
})
