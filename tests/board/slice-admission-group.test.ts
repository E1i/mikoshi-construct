import type { DatabaseSync } from 'node:sqlite'
import type { BusFacts } from '../../src/commands/board/bus.js'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { busJson, renderBoard } from '../../scripts/cli/board-page.js'
import { openBus } from '../../scripts/core/db.js'
import { CARD_ADMITTED } from '../../scripts/core/events.js'
import { reduce } from '../../scripts/core/reducer.js'
import { busIntakePorts } from '../../scripts/intake/intake.js'
import { busProjections } from '../../scripts/supervisor/composition.js'
import { busFacts } from '../../src/commands/board/index.js'
import { screenLines } from '../../src/commands/board/screens.js'
import { runAdmit } from '../../src/commands/intake/admit.js'
import { PLAIN_LORE } from '../../src/ui/lore.js'

const AT = new Date('2026-11-17T09:00:00.000Z')
const NOW = new Date('2026-11-17T10:00:00.000Z')
const HELD_SLICE = 71
const ADMITTED_SLICE = 72
const SLICES = 2
const BASE = 'grouped-card'
const MINUTE_MS = 60_000
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

interface World { parking: string, repo: string, db: DatabaseSync }

function world(): World {
  const root = mkdtempSync(path.join(tmpdir(), 'slice-admission-group-'))
  roots.push(root)
  const parking = path.join(root, 'parking')
  const repo = path.join(root, 'repo')
  mkdirSync(parking)
  mkdirSync(path.join(repo, 'src'), { recursive: true })
  writeFileSync(path.join(repo, 'src', 'a.ts'), '')
  return { parking, repo, db: openBus(path.join(root, 'bus.db')) }
}

function admit(w: World, id: number, part: number, minute: number): void {
  const name = `${BASE}-slice-${part}`
  const file = path.join(w.parking, `${id}.md`)
  writeFileSync(file, `card: #${id} ${name} [implement/construct/S/cheap/owner] · depends — · blocks —\nbranch: feat/${name}\ntouches: src/a.ts\ncontinue: stop\nwho: shift\npriority: p2\n\nDo the part.\n`)
  const ports = busIntakePorts(w.db, 'by-hand')
  const result = runAdmit({ file, dir: w.repo, dryRun: false, autoConfirm: true, parkingRoot: w.parking, events: ports.cardEvents, cardStates: ports.cardStates, admissions: ports.cardAdmissions }, () => new Date(AT.getTime() + MINUTE_MS * minute))
  expect(result.status).toBe('admitted')
}

function admittedBus(): World {
  const w = world()
  admit(w, HELD_SLICE, 2, 1)
  admit(w, ADMITTED_SLICE, 1, 2)
  reduce(w.db, 'pending', busProjections())
  return w
}

function parentsOnAdmission(db: DatabaseSync): [number, unknown][] {
  const rows = db.prepare('SELECT card_id, payload FROM events WHERE type = ? ORDER BY id').all(CARD_ADMITTED) as { card_id: number, payload: string }[]
  return rows.map(row => [Number(row.card_id), (JSON.parse(row.payload) as Record<string, unknown>).parent ?? null])
}

function page(facts: BusFacts): string {
  return renderBoard({
    version: '0.0.0',
    machine: { load: 0, cores: 1 },
    liveness: 'live',
    modelVersion: null,
    facts,
    windowGauges: null,
    limits: { contextLimit: null, cardContextLine: null, sessionSpend: null, agentSpend: null, warnRatio: null, modelWindows: new Map() },
    details: new Map(),
    decisions: { stale: null, rows: [], at: 0 },
    handoff: { file: 'miko.md', text: null },
    repository: null,
    tickMs: null,
    warnings: [],
  })
}

describe('an admitted -slice-N card renders in a slice group on the board', () => {
  it('an intake --admit of a slice beside a sibling the bus holds writes the parent on its card.admitted', () => {
    const w = admittedBus()
    try {
      expect(parentsOnAdmission(w.db)).toEqual([
        [HELD_SLICE, { card: HELD_SLICE, part: 2, of: SLICES }],
        [ADMITTED_SLICE, { card: HELD_SLICE, part: 1, of: SLICES }],
      ])
      expect(busFacts(w.db, NOW).cards.map(card => [card.id, card.parent ?? null])).toEqual([
        [HELD_SLICE, { card: HELD_SLICE, part: 2, of: SLICES }],
        [ADMITTED_SLICE, { card: HELD_SLICE, part: 1, of: SLICES }],
      ])
    }
    finally {
      w.db.close()
    }
  })

  it('the text, --json and page render both slices in one group', () => {
    const w = admittedBus()
    try {
      const facts = busFacts(w.db, NOW)
      const text = screenLines(facts, PLAIN_LORE).join('\n')
      expect(text).toContain(`#${ADMITTED_SLICE} ◧ 1/${SLICES} · of #${HELD_SLICE}`)
      expect(text).toContain(`#${HELD_SLICE} ◧ 2/${SLICES} · of #${HELD_SLICE}`)
      const json = JSON.parse(busJson(w.db, NOW)) as { tally: { cards: number, tasks: number }, cards: { id: number, mark: string | null }[] }
      expect(json.tally).toEqual({ cards: SLICES, tasks: 1 })
      expect(json.cards.map(card => [card.id, card.mark])).toEqual([
        [HELD_SLICE, `◧ 2/${SLICES} · of #${HELD_SLICE}`],
        [ADMITTED_SLICE, `◧ 1/${SLICES} · of #${HELD_SLICE}`],
      ])
      const html = page(facts)
      expect(html.match(new RegExp(`<tbody class="task-group" data-task="${HELD_SLICE}"`, 'g'))).toHaveLength(1)
      expect([HELD_SLICE, ADMITTED_SLICE].map(id => html.includes(`data-card="${id}"`))).toEqual([true, true])
    }
    finally {
      w.db.close()
    }
  })
})
