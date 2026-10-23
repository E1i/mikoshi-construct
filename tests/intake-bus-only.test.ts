import type { DatabaseSync } from 'node:sqlite'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openBus } from '../scripts/bus/db.js'
import { busIntakePorts, runBusIntake } from '../scripts/bus/intake.js'
import { reduce } from '../scripts/bus/reducer.js'
import { CARD_ADMITTED, CARD_MOVED } from '../scripts/core/events.js'
import { runAdmit } from '../src/commands/intake/admit.js'
import { runExport } from '../src/commands/intake/export.js'
import { INTAKE_EXIT, runIntake } from '../src/commands/intake/index.js'
import { runMove } from '../src/commands/intake/move.js'
import { parkingTree } from '../src/commands/intake/parking-tree.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

interface World { root: string, parking: string, journal: string, repo: string, db: DatabaseSync }

function world(): World {
  const root = mkdtempSync(path.join(tmpdir(), 'intake-bus-only-'))
  roots.push(root)
  const repo = path.join(root, 'repo')
  mkdirSync(path.join(repo, 'src', 'board'), { recursive: true })
  writeFileSync(path.join(repo, 'src', 'board', 'run.ts'), '')
  const journal = path.join(root, 'handoff', 'ghosts.jsonl')
  mkdirSync(path.dirname(journal), { recursive: true })
  const db = openBus(path.join(root, 'handoff', 'bus.db'))
  return { root, parking: path.join(root, 'parking'), journal, repo, db }
}

function draftOf(w: World, cards: Record<string, unknown>[]): string {
  const draft = path.join(w.root, 'draft.json')
  writeFileSync(draft, JSON.stringify({ cards }))
  return draft
}

function sliced(name: string, depends: string[] = []): Record<string, unknown> {
  return { name, kind: 'implement', milestone: 'runner', size: 'S', contour: 'cheap', decision: 'auto', who: 'shift', touches: ['src/board/run.ts'], depends, task: `Do the ${name} thing.`, witnesses: ['`pnpm run quality` is green'] }
}

function intakeThroughBus(w: World, cards: Record<string, unknown>[]): number[] {
  const ports = busIntakePorts(w.db)
  const result = runIntake({ draft: draftOf(w, cards), taken: '-', readStdin: () => '1', parking: w.parking, parkingRoot: w.parking, dir: w.repo, journal: w.journal, dryRun: false, autoConfirm: true, events: ports.cardEvents, cardStates: () => new Map() })
  expect(result.status).toBe('written')
  return result.status === 'written' ? result.cards.map(card => card.id) : []
}

function parkedMarkdown(parking: string): string[] {
  return parkingTree(parking).flatMap(dir => readdirSync(dir).filter(name => name.endsWith('.md')).map(name => path.join(dir, name)))
}

function admittedTexts(w: World, cardId: number): string[] {
  return (w.db.prepare(`SELECT json_extract(payload, '$.text') AS text FROM events WHERE type = ? AND card_id = ? ORDER BY id`).all(CARD_ADMITTED, cardId) as { text: string }[]).map(row => row.text)
}

async function exportThroughEntry(w: World, card: string): Promise<{ exit: typeof process.exitCode, output: string }> {
  const written: string[] = []
  const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    written.push(String(chunk))
    return true
  })
  const previousExit = process.exitCode
  try {
    await runBusIntake(w.db, ['--plain', '--export', card])
    return { exit: process.exitCode, output: written.join('') }
  }
  finally {
    write.mockRestore()
    process.exitCode = previousExit
  }
}

describe('intake and slicing write only into the bus', () => {
  it('after admit no parking md is written', () => {
    const w = world()
    const [first, second] = intakeThroughBus(w, [sliced('board-run'), sliced('board-tail')])
    expect(parkedMarkdown(w.parking)).toEqual([])
    expect(admittedTexts(w, first!)).toHaveLength(1)

    const ports = busIntakePorts(w.db)
    const admitted = runAdmit({ file: path.join(w.parking, `${second}.md`), dir: w.repo, journal: w.journal, dryRun: false, autoConfirm: true, parkingRoot: w.parking, events: ports.cardEvents, cardStates: () => new Map(), admissions: ports.cardAdmissions })
    expect(admitted.status).toMatch(/^(?:admitted|alreadyAdmitted)$/)
    expect(runMove({ move: `#${first}`, to: 'lane-01', draft: undefined, taken: undefined, admit: undefined, parking: w.parking, events: ports.cardEvents, admissions: ports.cardAdmissions })).toMatchObject({ status: 'moved', event: CARD_MOVED })
    reduce(w.db)
    expect(parkedMarkdown(w.parking)).toEqual([])
    expect(admittedTexts(w, first!).at(-1)).toBe(admittedTexts(w, first!)[0])
    w.db.close()
  })

  it('a hand-written card admitted through the bus with a correction leaves its file as the person wrote it', () => {
    const w = world()
    mkdirSync(w.parking, { recursive: true })
    const file = path.join(w.parking, '80.md')
    const written = 'card: #80 hand-card [implement/runner/S/cheap/owner] · depends — · blocks —\nbranch: feat/card-80\ntouches: scripts/board/run.ts\ncontinue: stop\nwho: shift\n\nDo the thing.\n'
    writeFileSync(file, written)
    const ports = busIntakePorts(w.db)
    const result = runAdmit({ file, dir: w.repo, journal: w.journal, dryRun: false, autoConfirm: true, parkingRoot: w.parking, events: ports.cardEvents, cardStates: () => new Map(), admissions: ports.cardAdmissions })
    expect(result).toMatchObject({ status: 'admitted', card: { corrections: [expect.anything()] } })
    expect(readFileSync(file, 'utf8')).toBe(written)
    expect(admittedTexts(w, 80).at(-1)).not.toBe(written)
    w.db.close()
  })

  it('the export of an admitted card gives the same text', async () => {
    const w = world()
    const [id] = intakeThroughBus(w, [sliced('board-run')])
    const [text] = admittedTexts(w, id!)
    expect(runExport({ card: `#${id}`, admissions: busIntakePorts(w.db).cardAdmissions })).toEqual({ status: 'exported', text })
    reduce(w.db)
    const { exit, output } = await exportThroughEntry(w, `#${id}`)
    expect(exit).not.toBe(INTAKE_EXIT.refused)
    expect(output).toBe(text)
    w.db.close()
  })

  it('the export refuses a card the bus never admitted and a value that is no card number, writing nothing to stdout', async () => {
    const w = world()
    const admissions = busIntakePorts(w.db).cardAdmissions
    expect(runExport({ card: '#77', admissions })).toMatchObject({ status: 'refused', refusal: 'notAdmitted' })
    expect(runExport({ card: 'lane-01', admissions })).toMatchObject({ status: 'refused', refusal: 'notACard' })
    expect(await exportThroughEntry(w, '#77')).toEqual({ exit: INTAKE_EXIT.refused, output: expect.not.stringContaining('card:') })
    w.db.close()
  })
})
