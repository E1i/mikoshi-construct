import type { SeedEvent } from '../../../tests/board/bus-fixture.js'
import type { LawCell, LawId, SiteBeyondNodes } from '../../nodes/laws.js'
import type { GitHub } from '../../ports/github.js'
import type { CardActivity } from '../../window/watch.js'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { writeBus } from '../../../tests/board/bus-fixture.js'
import { ABANDONED_TITLE } from '../../ci/required.js'
import { printBoard } from '../../cli/board-page.js'
import { lawsSection } from '../../contract/factory/laws.js'
import { lawGapNumbers, readRatchet } from '../../contract/ratchet.js'
import { openBus } from '../../core/db.js'
import { CARD_STARTED, SESSION_HEARTBEAT, WINDOW_HEARTBEAT } from '../../core/events.js'
import { FACTORY_WORKERS } from '../../core/factory-paths.js'
import { rerunDueOn } from '../../core/observations.js'
import { ABANDONED_READ_AS_RERUN, LAW_CELLS, LAW_NODES, LAW_SITES, lawIds, PULSE_BESIDE_CARD_SILENCE, REVIEW_STALL_IS_NOT_A_SILENT_LOOP, SITES_BEYOND_NODES, sourceOf, WINDOW_BESIDE_SESSIONS } from '../../nodes/laws.js'
import { NetWatch, TICK_MS } from '../../ports/netwatch.js'
import { BusTick } from '../../supervisor/run.js'
import { BUS_ALIVE_MS, STALL_MS, stalledOf } from '../../window/watch.js'
import { Clock, FakeGitHub, sha } from '../bus/github-fake.js'
import { reachesSite } from './law-reach.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')
const NOW = new Date('2026-11-09T15:40:00.000Z')
const MINUTE = 60_000
const STALE_WINDOW_BEAT = '2026-11-07T14:39:00.000Z'
const LIVE_HEADER = 'id="bus-live">bus live<'
const SILENT_SESSION_MINUTES = 120
const INTAKE_READS_DECISIONS = 1779
const BEYOND: readonly SiteBeyondNodes[] = ['netwatch', 'window', 'intake', 'supervisor']
const roots: string[] = []

beforeEach(() => {
  vi.stubEnv('BUS_RERUN', '')
})

afterEach(() => {
  vi.unstubAllEnvs()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

interface Witness {
  law: LawId
  run: (site: SiteBeyondNodes) => void
}

function ago(milliseconds: number): string {
  return new Date(NOW.getTime() - milliseconds).toISOString()
}

function boardReadsLive(events: SeedEvent[]): boolean {
  const root = mkdtempSync(path.join(tmpdir(), 'law-sites-'))
  roots.push(root)
  const busPath = writeBus(path.join(root, 'bus.db'), { events })
  const db = new DatabaseSync(busPath)
  try {
    db.exec('ALTER TABLE card_bodies ADD COLUMN admission_event_id INTEGER; ALTER TABLE card_bodies ADD COLUMN text_sha TEXT NOT NULL DEFAULT \'\'')
  }
  finally {
    db.close()
  }
  let html = ''
  printBoard(busPath, NOW, (text) => {
    html += text
  }, path.join(root, 'miko.md'), 'html')
  return html.includes(LIVE_HEADER)
}

function windowBesideSessions(): void {
  const staleWindow: SeedEvent = { ts: STALE_WINDOW_BEAT, type: WINDOW_HEARTBEAT, card: null, payload: JSON.stringify({ session: 'window' }) }
  const session = (beat: string): SeedEvent[] => [
    staleWindow,
    { ts: ago(7 * MINUTE), type: CARD_STARTED, card: 45, payload: JSON.stringify({ session: 's-45' }) },
    { ts: beat, type: SESSION_HEARTBEAT, card: 45, payload: JSON.stringify({ session: 's-45', step: 'launch' }) },
  ]
  if (!boardReadsLive(session(ago(MINUTE))))
    throw new Error('a stale window beat beside a card session beating a minute ago reads the factory down')
  if (boardReadsLive(session(ago(SILENT_SESSION_MINUTES * MINUTE))))
    throw new Error('a stale window beat beside a silent card session reads the factory live')
}

function pulseBesideCardSilence(): void {
  const silent: CardActivity = { cardId: 45, lastEventId: 7, lastType: CARD_STARTED, lastTs: ago(STALL_MS + MINUTE) }
  const speaking: CardActivity = { ...silent, cardId: 46, lastTs: ago(MINUTE) }
  const now = NOW.getTime()
  if (stalledOf([silent, speaking], ago(MINUTE), now).map(card => card.cardId).join() !== '45')
    throw new Error('a fresh netwatch pulse beside a silent card does not read that card stalled')
  if (stalledOf([silent], ago(BUS_ALIVE_MS + MINUTE), now).length !== 0)
    throw new Error('a silent card reads stalled while the netwatch pulse is stale too')
  if (stalledOf([silent], undefined, now).length !== 0)
    throw new Error('a silent card reads stalled with no netwatch pulse at all')
}

function abandonedReadAsRerun(): void {
  const root = mkdtempSync(path.join(tmpdir(), 'law-sites-z2-'))
  roots.push(root)
  const db = openBus(path.join(root, 'bus.db'))
  try {
    const gitHub = new FakeGitHub()
    const clock = new Clock()
    const abandonedHead = sha('a')
    const client: GitHub = (endpoint) => {
      const annotations = /check-runs\/(\d+)\/annotations$/.exec(endpoint)
      if (annotations !== null)
        return { status: 200, headers: {}, body: [{ title: annotations[1] === '1' ? ABANDONED_TITLE : 'CI / required is red' }] }
      const response = gitHub.client(endpoint)
      const head = /\/commits\/([0-9a-f]{40})\/check-runs/.exec(endpoint)?.[1]
      if (head === undefined)
        return response
      const id = head === abandonedHead ? 1 : 2
      const body = response.body as { check_runs: { name: string, conclusion: string | null }[] }
      return { ...response, body: { check_runs: body.check_runs.map(check => check.name === 'required' && check.conclusion === 'failure' ? { ...check, id, output: { annotations_count: 1, annotations_url: `https://api.github.com/repos/{owner}/{repo}/check-runs/${id}/annotations` } } : check) } }
    }
    const tick = new BusTick(db, new NetWatch(db, client, clock.now), clock.now, () => {})
    tick.run()
    clock.advance(TICK_MS)
    gitHub.open({ number: 1493, head: abandonedHead, required: 'failure', failed: [] })
    gitHub.open({ number: 1494, head: sha('b'), required: 'failure', failed: [] })
    tick.run()
    if (!rerunDueOn(db, 1493, abandonedHead))
      throw new Error('netwatch read a required red only from abandoned jobs as a defect, not a rerun due')
    if (rerunDueOn(db, 1494, sha('b')))
      throw new Error('netwatch read a required red with no abandoned annotation as a rerun due')
  }
  finally {
    db.close()
  }
}

const WITNESSES: Readonly<Record<string, Witness>> = {
  [ABANDONED_READ_AS_RERUN]: { law: 'Z2', run: abandonedReadAsRerun },
  [WINDOW_BESIDE_SESSIONS]: { law: 'Z7', run: windowBesideSessions },
  [PULSE_BESIDE_CARD_SILENCE]: { law: 'Z7', run: pulseBesideCardSilence },
}

function cellFault(law: LawId, site: SiteBeyondNodes, cell: LawCell | undefined): string | null {
  if (cell === undefined)
    return `${law} × ${site}: no cell`
  if (['witness', 'notApplicable', 'gap'].filter(kind => kind in cell).length !== 1)
    return `${law} × ${site}: a cell is exactly one of witness, notApplicable or gap`
  if ('witness' in cell)
    return WITNESSES[cell.witness]?.law === law ? null : `${law} × ${site}: witness ${cell.witness} is not a witness of ${law} this suite runs`
  if ('notApplicable' in cell)
    return cell.notApplicable.trim() === '' ? `${law} × ${site}: not applicable without its reason` : null
  return cell.gap.length > 0 && cell.gap.every(card => Number.isInteger(card) && card > 0) ? null : `${law} × ${site}: a gap names the card that closes it`
}

function siteFaults(site: SiteBeyondNodes, cells: typeof LAW_CELLS = LAW_CELLS): string[] {
  return lawIds().flatMap((law) => {
    const fault = cellFault(law, site, cells[law][site])
    return fault === null ? [] : [fault]
  })
}

describe('law sites beyond the bus nodes', () => {
  it('every law site has its source file, and the 8 bus nodes stay as they were', () => {
    expect(LAW_SITES).toEqual([...LAW_NODES, ...BEYOND])
    expect(Object.keys(SITES_BEYOND_NODES)).toEqual([...BEYOND])
    expect(LAW_NODES).toHaveLength(8)
    expect(LAW_SITES.filter(site => !existsSync(path.join(REPO_ROOT, sourceOf(site))))).toEqual([])
    expect(sourceOf('netwatch')).toBe('scripts/ports/netwatch.ts')
    expect(sourceOf('window')).toBe('scripts/window/watch.ts')
    expect(LAW_NODES.map(sourceOf)).toEqual(LAW_NODES.map(node => FACTORY_WORKERS[node]))
  })

  it('liveness is witnessed on netwatch and on the window', () => {
    for (const site of ['netwatch', 'window'] as const) {
      const cell = LAW_CELLS.Z7[site]

      expect('witness' in cell, `Z7 × ${site}`).toBe(true)
      const witness = WITNESSES[(cell as { witness: string }).witness]
      expect(witness?.law).toBe('Z7')
      witness!.run(site)
    }
  })

  it('intake is a law site with a cell for every law', () => {
    expect(sourceOf('intake')).toBe('src/commands/intake/admit.ts')
    expect(siteFaults('intake')).toEqual([])
    expect(LAW_CELLS.Z3.intake).toEqual({ gap: [INTAKE_READS_DECISIONS] })
    expect(readRatchet(REPO_ROOT)['law-gaps:Z3:intake']).toBe(1)
    expect(Object.keys(lawsSection().laws.Z3.cells)).toContain('intake')

    const missing = { ...LAW_CELLS, Z5: Object.fromEntries(Object.entries(LAW_CELLS.Z5).filter(([site]) => site !== 'intake')) } as unknown as typeof LAW_CELLS
    const unreasoned = { ...LAW_CELLS, Z1: { ...LAW_CELLS.Z1, intake: { notApplicable: ' ' } } }
    const unwitnessed = { ...LAW_CELLS, Z7: { ...LAW_CELLS.Z7, intake: { witness: 'Z7-unwritten' } } }

    expect(siteFaults('intake', missing)).toEqual(['Z5 × intake: no cell'])
    expect(siteFaults('intake', unreasoned)).toEqual(['Z1 × intake: not applicable without its reason'])
    expect(siteFaults('intake', unwitnessed)).toEqual([expect.stringContaining('Z7 × intake: witness Z7-unwritten')])
  })

  it('supervisor is a law site and Z7 x supervisor names the card that ends the single-signal stall kill', () => {
    expect(sourceOf('supervisor')).toBe('scripts/supervisor/stalled-sessions.ts')
    expect(siteFaults('supervisor')).toEqual([])
    expect(LAW_CELLS.Z7.supervisor).toEqual({ gap: [REVIEW_STALL_IS_NOT_A_SILENT_LOOP] })
    expect(REVIEW_STALL_IS_NOT_A_SILENT_LOOP).toBe(1792)
    expect(readRatchet(REPO_ROOT)['law-gaps:Z7:supervisor']).toBe(1)
    expect(Object.keys(lawsSection().laws.Z7.cells)).toContain('supervisor')
  })

  it('a witness run reaches a site only when it calls a function of the site module', async () => {
    expect(await reachesSite('netwatch', abandonedReadAsRerun)).toBe(true)
    expect(await reachesSite('netwatch', () => TICK_MS)).toBe(false)
    expect(await reachesSite('netwatch', () => stalledOf([], undefined, NOW.getTime()))).toBe(false)
    expect(await reachesSite('window', () => stalledOf([], undefined, NOW.getTime()))).toBe(true)
  })

  it('every cell of a site beyond the nodes is a witness, a reasoned not applicable or a gap the ratchet records', () => {
    const recorded = readRatchet(REPO_ROOT)

    for (const site of BEYOND)
      expect(siteFaults(site), site).toEqual([])
    for (const key of Object.keys(lawGapNumbers()))
      expect(recorded[key], key).toBe(1)
  })

  describe('each witness cell beyond the nodes runs', () => {
    for (const law of lawIds()) {
      for (const site of BEYOND) {
        const cell = LAW_CELLS[law][site]
        if ('witness' in cell) {
          it(`${law} × ${site}`, () => {
            WITNESSES[cell.witness]!.run(site)
          })
        }
      }
    }
  })
})
