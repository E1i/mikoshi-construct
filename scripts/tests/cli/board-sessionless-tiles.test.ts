import type { CardService, EventSlices, SessionCardParts, SessionView, SlicedRow } from '../../cli/board-page/session-card.js'
import { describe, expect, it } from 'vitest'
import { nodeViewOf, sessionCard, SESSIONLESS_ROLES } from '../../cli/board-page/session-card.js'
import { MERGE_DONE, TASK_LEASED, WITNESS_PHASE, WITNESS_RECORDED } from '../../core/events.js'

const NOW = new Date('2026-11-27T08:00:00.000Z')
const CARD = 2361
const ON_BASE = 'base'
const ON_HEAD = 'head'
const TRANSCRIPT_CAPTIONS = /NO TRANSCRIPT READ|LAST · |NOW · |CAUSE UNKNOWN|class="term/
const PARTS: SessionCardParts = { opener: '', hint: '', bars: '', agents: '', over: false, now: NOW.toISOString() }
const OTHER_SESSION_TERMINAL = { name: 'Write', at: '2026-11-27T07:50:00.000Z', endedAt: '2026-11-27T07:51:00.000Z', command: 'report.md' }
const NO_VIEW: SessionView = { startedAt: null, expectedMs: null, steps: [], terminal: null }

interface Seeded extends SlicedRow {
  type: string
}

function minutesAgo(minutes: number): string {
  return new Date(NOW.getTime() - minutes * 60_000).toISOString()
}

function service(role: string): CardService {
  return { role, task: `#${CARD}`, step: `${role} abc1234` }
}

function slicesOver(rows: readonly Omit<Seeded, 'id'>[]): EventSlices {
  const seeded = rows.map((row, at) => ({ ...row, id: at + 1 }))
  return (type, _fields, from, last) => {
    const matched = seeded.filter(row => row.type === type && row.id >= from)
    return last ? matched.slice(-1) : matched
  }
}

function row(type: string, minutes: number, fields: Record<string, unknown>): Omit<Seeded, 'id'> {
  return { type, ts: minutesAgo(minutes), fields }
}

function witnessView(phases: { phase: string, witness: string, minutes: number }[], terminal: SessionView['terminal'] = OTHER_SESSION_TERMINAL): SessionView {
  return { startedAt: minutesAgo(6), expectedMs: null, steps: [], terminal, node: { phases: phases.map(({ phase, witness, minutes }) => ({ phase, witness, at: minutesAgo(minutes) })), outcome: null } }
}

describe('a sessionless node tile', () => {
  it('a witness tile renders its base and head steps and no transcript line', () => {
    const tile = sessionCard(service('witness'), witnessView([{ phase: ON_BASE, witness: 'W1', minutes: 5 }, { phase: ON_HEAD, witness: 'W1', minutes: 2 }]), PARTS)
    expect(tile).toContain('<div class="round-steps" data-node="witness"><ol><li data-passed>base</li><li data-current>head</li><li>verdict</li></ol><span class="round-step-now">W1 · head · 2 min</span></div>')
    expect(tile).toContain('<div class="svc-state" data-state="acting">RUNNING · W1 ON HEAD</div>')
    expect(tile).not.toMatch(TRANSCRIPT_CAPTIONS)
    expect(tile).not.toContain('report.md')
    const leased = sessionCard(service('witness'), { ...NO_VIEW, startedAt: minutesAgo(3) }, PARTS)
    expect(leased).toContain('<ol><li>base</li><li>head</li><li>verdict</li></ol><span class="round-step-now">leased · 3 min</span>')
    expect(leased).not.toMatch(TRANSCRIPT_CAPTIONS)
  })

  it('a witness tile shows the verdict once recorded', () => {
    const view: SessionView = { ...witnessView([{ phase: ON_BASE, witness: 'W1', minutes: 5 }, { phase: ON_HEAD, witness: 'W1', minutes: 2 }]), node: { phases: [], outcome: { word: 'green', at: minutesAgo(1) } } }
    const tile = sessionCard(service('witness'), view, PARTS)
    expect(tile).toContain('<ol><li data-passed>base</li><li data-passed>head</li><li data-passed>verdict</li></ol><span class="round-step-now">green · recorded 07:59:00</span>')
    expect(tile).toContain('RECORDED · GREEN')
    expect(tile).not.toMatch(TRANSCRIPT_CAPTIONS)
  })

  it('update, merge and close tiles show their lease time and recorded outcome and no transcript line', () => {
    expect([...SESSIONLESS_ROLES].sort()).toEqual(['close', 'merge', 'update', 'witness'])
    for (const role of ['update', 'merge', 'close']) {
      const tile = sessionCard(service(role), { startedAt: minutesAgo(4), expectedMs: null, steps: [], terminal: OTHER_SESSION_TERMINAL }, PARTS)
      expect(tile).toContain(`<div class="round-steps" data-node="${role}"><span class="round-step-now">leased · 4 min</span></div>`)
      expect(tile).not.toMatch(TRANSCRIPT_CAPTIONS)
    }
    const merged = sessionCard(service('merge'), nodeViewOf(slicesOver([row(TASK_LEASED, 3, { queue: 'merge' }), row(MERGE_DONE, 1, { commit: 'f'.repeat(40) })]), 'merge'), PARTS)
    expect(merged).toContain('<span class="round-step-now">merged · recorded 07:59:00</span>')
    expect(merged).toContain('RECORDED · MERGED')
  })

  it('the node view reads only the steps and outcome recorded after its own lease', () => {
    const slices = slicesOver([
      row(WITNESS_PHASE, 30, { phase: ON_BASE, witness: 'W9' }),
      row(WITNESS_RECORDED, 29, { verdict: 'red' }),
      row(TASK_LEASED, 7, { queue: 'answer' }),
      row(TASK_LEASED, 6, { queue: 'witness' }),
      row(WITNESS_PHASE, 5, { phase: ON_BASE, witness: 'W1' }),
      row(WITNESS_PHASE, 2, { phase: ON_HEAD, witness: 'W1' }),
    ])
    const view = nodeViewOf(slices, 'witness')
    expect(view).toEqual({ startedAt: minutesAgo(6), expectedMs: null, steps: [], terminal: null, node: { phases: [{ phase: ON_BASE, witness: 'W1', at: minutesAgo(5) }, { phase: ON_HEAD, witness: 'W1', at: minutesAgo(2) }], outcome: null } })
  })

  it('the node view anchors on its own queue lease when a later lease of another queue follows it', () => {
    const slices = slicesOver([
      row(TASK_LEASED, 6, { queue: 'witness' }),
      row(WITNESS_PHASE, 5, { phase: ON_BASE, witness: 'W1' }),
      row(TASK_LEASED, 4, { queue: 'review' }),
      row(WITNESS_PHASE, 2, { phase: ON_HEAD, witness: 'W1' }),
    ])
    const view = nodeViewOf(slices, 'witness')
    expect(view.startedAt).toBe(minutesAgo(6))
    expect(view.node?.phases.map(({ phase }) => phase)).toEqual([ON_BASE, ON_HEAD])
  })

  it('a witness tile reads its verdict from the witness.recorded row after its lease', () => {
    const slices = slicesOver([
      row(TASK_LEASED, 6, { queue: 'witness' }),
      row(WITNESS_PHASE, 5, { phase: ON_BASE, witness: 'W1' }),
      row(WITNESS_PHASE, 2, { phase: ON_HEAD, witness: 'W1' }),
      row(WITNESS_RECORDED, 1, { verdict: 'green' }),
    ])
    const tile = sessionCard(service('witness'), nodeViewOf(slices, 'witness'), PARTS)
    expect(tile).toContain('RECORDED · GREEN')
    expect(tile).toContain('<span class="round-step-now">green · recorded 07:59:00</span>')
  })
})
