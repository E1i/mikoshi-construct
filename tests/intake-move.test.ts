import type { CardEvent, CardEventPort } from '../src/commands/intake/index.js'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CARD_ADMITTED, CARD_DROPPED, CARD_MOVED } from '../scripts/core/events.js'
import { runAdmit } from '../src/commands/intake/admit.js'
import { bodySha } from '../src/commands/intake/confirm.js'
import { printMove, runMove } from '../src/commands/intake/move.js'
import { createUi } from '../src/ui/console.js'
import { resolveTheme } from '../src/ui/theme.js'

const NOW = new Date('2026-10-07T09:00:00.000Z')
const AFTER_THE_CUTOFF = new Date('2026-10-13T09:00:00.000Z')
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function world(): { parking: string, journal: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'intake-move-'))
  roots.push(root)
  const parking = path.join(root, 'parking')
  mkdirSync(parking)
  return { parking, journal: path.join(root, 'handoff', 'ghosts.jsonl') }
}

function park(dir: string, id: number, body = 'Do the thing.'): string {
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${id}.md`)
  writeFileSync(file, `card: #${id} card-${id} [implement/black-ice/S/cheap/owner] · depends — · blocks —\nbranch: feat/card-${id}\ntouches: src/a.ts\ncontinue: stop\nwho: window\n\n${body}\n`)
  return file
}

function move(w: { parking: string, journal: string }, id: number, to: string, events: CardEventPort = () => {}) {
  return runMove({ move: `#${id}`, to, draft: undefined, taken: undefined, admit: undefined, parking: w.parking, journal: w.journal, events }, () => NOW)
}

function admitThenMove(w: { parking: string, journal: string }, events?: CardEventPort): void {
  const file = park(w.parking, 706)
  const repo = path.join(path.dirname(w.parking), 'repo')
  mkdirSync(path.join(repo, 'src'), { recursive: true })
  writeFileSync(path.join(repo, 'src', 'a.ts'), '')
  expect(runAdmit({ file, dir: repo, journal: w.journal, dryRun: false, autoConfirm: true, parkingRoot: w.parking, events }, () => AFTER_THE_CUTOFF).status).toBe('admitted')
  expect(runMove({ move: '#706', to: 'lane-3', draft: undefined, taken: undefined, admit: undefined, parking: w.parking, journal: w.journal, events }, () => AFTER_THE_CUTOFF).status).toBe('moved')
}

function journalLines(journal: string): Record<string, unknown>[] {
  return existsSync(journal) ? readFileSync(journal, 'utf8').trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>) : []
}

function printed(result: ReturnType<typeof runMove>): { lines: string[], exit: number } {
  const lines: string[] = []
  const exit = printMove(createUi(resolveTheme({ plain: true }), line => lines.push(line)), result)
  return { lines, exit }
}

describe('intake --move', () => {
  it('moves a card to another directory and back', () => {
    const w = world()
    const file = park(w.parking, 700)
    const text = readFileSync(file, 'utf8')
    expect(move(w, 700, 'after-0.42').status).toBe('moved')
    const moved = path.join(w.parking, 'after-0.42', '700.md')
    expect(existsSync(file)).toBe(false)
    expect(readFileSync(moved, 'utf8')).toBe(text)
    expect(move(w, 700, '.').status).toBe('moved')
    expect(readFileSync(file, 'utf8')).toBe(text)
    expect(existsSync(moved)).toBe(false)
    const lines = journalLines(w.journal)
    expect(lines).toEqual([
      { event: 'intake-move', task: '700', from: w.parking, to: path.join(w.parking, 'after-0.42'), bodySha: bodySha(text), ts: NOW.toISOString() },
      { event: 'intake-move', task: '700', from: path.join(w.parking, 'after-0.42'), to: w.parking, bodySha: bodySha(text), ts: NOW.toISOString() },
    ])
  })

  it('a moved card writes card.moved to the bus beside its journal line', () => {
    const w = world()
    const text = readFileSync(park(w.parking, 704), 'utf8')
    const bus: CardEvent[] = []
    expect(move(w, 704, 'lane-2', event => bus.push(event)).status).toBe('moved')
    const to = path.join(w.parking, 'lane-2')
    expect(bus).toEqual([{
      type: CARD_MOVED,
      cardId: 704,
      ts: NOW.toISOString(),
      dedupeKey: `${CARD_MOVED}:704:lane-2:${NOW.toISOString()}`,
      payload: { from: w.parking, to, bodySha: bodySha(text), lane: 'lane-2' },
    }])
    expect(journalLines(w.journal)).toEqual([{ event: 'intake-move', task: '704', from: w.parking, to, bodySha: bodySha(text), ts: NOW.toISOString() }])
  })

  it('with a connected bus after the cutoff intake writes no journal line', () => {
    const w = world()
    const bus: CardEvent[] = []
    admitThenMove(w, event => bus.push(event))
    expect(bus.map(event => event.type)).toEqual([CARD_ADMITTED, CARD_MOVED])
    expect(journalLines(w.journal)).toEqual([])
  })

  it('without a bus a move is refused: the file stays and no journal line holds a move', () => {
    const w = world()
    const file = park(w.parking, 708)
    const result = runMove({ move: '#708', to: 'lane-2', draft: undefined, taken: undefined, admit: undefined, parking: w.parking, journal: w.journal }, () => NOW)
    expect(printed(result)).toEqual({ lines: [expect.stringContaining('a move is held only by the bus')], exit: 1 })
    expect(existsSync(file)).toBe(true)
    expect(journalLines(w.journal)).toEqual([])
  })

  it('a move into the folder that already holds the card writes card.moved and leaves the file where it is', () => {
    const w = world()
    const file = park(path.join(w.parking, 'notes'), 709)
    const text = readFileSync(file, 'utf8')
    const bus: CardEvent[] = []
    const result = move(w, 709, 'notes', event => bus.push(event))
    expect(result).toEqual({ status: 'recordedInPlace', file, event: CARD_MOVED })
    expect(printed(result).lines.join('\n')).toContain('the file was not moved')
    expect(readFileSync(file, 'utf8')).toBe(text)
    expect(bus).toMatchObject([{ type: CARD_MOVED, cardId: 709, payload: { from: path.dirname(file), to: path.dirname(file), lane: 'notes' } }])
  })

  it('a move into dropped writes card.dropped, not card.moved, also when the card already sits there', () => {
    const w = world()
    park(w.parking, 710)
    const inPlace = park(path.join(w.parking, 'dropped'), 711)
    const bus: CardEvent[] = []
    expect(move(w, 710, 'dropped', event => bus.push(event)).status).toBe('moved')
    const recorded = move(w, 711, 'dropped', event => bus.push(event))
    expect(recorded).toEqual({ status: 'recordedInPlace', file: inPlace, event: CARD_DROPPED })
    expect(printed(recorded).lines.join('\n')).toContain('The bus holds the move as card.dropped; the file was not moved.')
    const to = path.join(w.parking, 'dropped')
    expect(bus).toMatchObject([
      { type: CARD_DROPPED, cardId: 710, dedupeKey: `${CARD_DROPPED}:710:dropped:${NOW.toISOString()}`, payload: { from: w.parking, to, lane: 'dropped' } },
      { type: CARD_DROPPED, cardId: 711, payload: { from: to, to, lane: 'dropped' } },
    ])
  })

  it.each(['archive', 'superseded'])('a move into %s is a drop: it writes card.dropped and says so', (lane) => {
    const w = world()
    park(w.parking, 713)
    const bus: CardEvent[] = []
    const result = move(w, 713, lane, event => bus.push(event))
    expect(result).toMatchObject({ status: 'moved', event: CARD_DROPPED })
    expect(printed(result).lines.join('\n')).toContain('The bus holds the move as card.dropped; the card is unchanged.')
    expect(bus).toMatchObject([{ type: CARD_DROPPED, cardId: 713, payload: { lane } }])
  })

  it('a move the bus refuses puts the file back, removes the directory it created and leaves no journal line', () => {
    const w = world()
    const file = park(w.parking, 710)
    expect(() => move(w, 710, 'archive', () => {
      throw new Error('refused by the bus')
    })).toThrow('refused by the bus')
    expect(existsSync(file)).toBe(true)
    expect(existsSync(path.join(w.parking, 'archive'))).toBe(false)
    expect(journalLines(w.journal)).toEqual([])
  })

  it('a move the bus refuses into a directory that already existed keeps that directory', () => {
    const w = world()
    const file = park(w.parking, 711)
    park(path.join(w.parking, 'archive'), 712)
    expect(() => move(w, 711, 'archive', () => {
      throw new Error('refused by the bus')
    })).toThrow('refused by the bus')
    expect(existsSync(file)).toBe(true)
    expect(existsSync(path.join(w.parking, 'archive', '712.md'))).toBe(true)
  })

  it('a bus-wired move says the bus holds the move', () => {
    const w = world()
    park(w.parking, 707)
    const { lines } = printed(move(w, 707, 'lane-2', () => {}))
    expect(lines.join('\n')).toContain('The bus holds the move as card.moved; the card is unchanged.')
  })

  it('a move into a missing directory creates it', () => {
    const w = world()
    park(w.parking, 701)
    expect(move(w, 701, 'later').status).toBe('moved')
    expect(existsSync(path.join(w.parking, 'later', '701.md'))).toBe(true)
  })

  it.each(['..', '../outside', '/tmp/elsewhere', 'a/b', ''])('refuses --to %j, which is not the root or one directory under it', (to) => {
    const w = world()
    const file = park(w.parking, 703)
    const result = move(w, 703, to)
    expect(result.status).toBe('refused')
    expect(printed(result).exit).toBe(1)
    expect(existsSync(file)).toBe(true)
    expect(journalLines(w.journal)).toEqual([])
  })

  it('refuses a move onto a number already in the target directory as parked in more than one place', () => {
    const w = world()
    const file = park(w.parking, 702)
    const other = park(path.join(w.parking, 'later'), 702, 'Another.')
    const before = readFileSync(other, 'utf8')
    const result = move(w, 702, 'later')
    expect(result.status).toBe('refused')
    expect(printed(result).exit).toBe(1)
    expect(printed(result).lines.join('\n')).toContain('more than one place')
    expect(existsSync(file)).toBe(true)
    expect(readFileSync(other, 'utf8')).toBe(before)
    expect(journalLines(w.journal)).toEqual([])
  })

  it('refuses a number found in more than one place, naming both paths', () => {
    const w = world()
    const a = park(w.parking, 703)
    const b = park(path.join(w.parking, 'after-0.42'), 703)
    const result = move(w, 703, 'later')
    expect(printed(result).lines.join('\n')).toContain(a)
    expect(printed(result).lines.join('\n')).toContain(b)
    expect(existsSync(a)).toBe(true)
    expect(journalLines(w.journal)).toEqual([])
  })

  it('refuses a card that is not parked and a card the grammar refuses', () => {
    const w = world()
    expect(move(w, 704, 'later').status).toBe('refused')
    const file = path.join(w.parking, '705.md')
    writeFileSync(file, 'not a card\n')
    expect(move(w, 705, 'later').status).toBe('refused')
    expect(existsSync(file)).toBe(true)
  })
})
