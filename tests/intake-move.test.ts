import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { bodySha } from '../src/commands/intake/confirm.js'
import { printMove, runMove } from '../src/commands/intake/move.js'
import { createUi } from '../src/ui/console.js'
import { resolveTheme } from '../src/ui/theme.js'

const NOW = new Date('2026-10-07T09:00:00.000Z')
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
  writeFileSync(file, `card: #${id} card-${id} [implement/black-ice/S/cheap/owner] · depends — · blocks —\nbranch: feat/card-${id}\ntouches: src/**\ncontinue: stop\nwho: window\n\n${body}\n`)
  return file
}

function move(w: { parking: string, journal: string }, id: number, to: string) {
  return runMove({ move: `#${id}`, to, draft: undefined, taken: undefined, admit: undefined, parking: w.parking, journal: w.journal }, () => NOW)
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

  it('refuses a move onto a number already in the target directory', () => {
    const w = world()
    const file = park(w.parking, 702)
    const other = park(path.join(w.parking, 'later'), 702, 'Another.')
    const before = readFileSync(other, 'utf8')
    const result = move(w, 702, 'later')
    expect(result.status).toBe('refused')
    expect(printed(result).exit).toBe(1)
    expect(printed(result).lines.join('\n')).toContain('already holds #702')
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
