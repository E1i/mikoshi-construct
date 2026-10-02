import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { boardJson, printBoard, readBoard } from '../../src/commands/board/index.js'
import { createUi } from '../../src/ui/console.js'
import { resolveTheme } from '../../src/ui/theme.js'

const NOW = new Date('2026-10-02T12:00:00.000Z')
const HOUR = 3_600_000
const NO_STDIN = (): string => ''
const LONG_TITLE = 'a pull request title that runs well past forty characters'

function at(offset: number): string {
  return new Date(NOW.getTime() + offset).toISOString()
}

function pr(number: number, title: string, state: string, statusCheckRollup: unknown, times: Record<string, string | null> = {}): unknown {
  return { number, title, state, createdAt: at(-3 * HOUR), closedAt: null, mergedAt: null, statusCheckRollup, ...times }
}

function withPrs(prs: unknown[]): { dir: string, file: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'construct-board-minors-'))
  const file = path.join(dir, 'prs.json')
  writeFileSync(file, JSON.stringify(prs))
  return { dir, file }
}

function read(prs: unknown[]): ReturnType<typeof readBoard> {
  const { dir, file } = withPrs(prs)
  return readBoard(dir, { all: false, staleHours: 4, prs: file, readStdin: NO_STDIN, now: NOW })
}

function render(prs: unknown[]): { lines: string[], exit: number } {
  const lines: string[] = []
  const ui = createUi(resolveTheme({ plain: true }), text => lines.push(text.replace(/\n$/, '')))
  const exit = printBoard(ui, read(prs))
  return { lines, exit }
}

function tasks(lines: string[]): string[] {
  return lines.filter(line => line.startsWith('│')).slice(1).map(line => line.split('│')[1]!.trim())
}

describe('board minors of #444', () => {
  it('keeps a pull request title whole in the table, the merged line and --json', () => {
    const prs = [pr(1, LONG_TITLE, 'OPEN', []), pr(2, LONG_TITLE, 'MERGED', [], { mergedAt: at(-HOUR) })]
    const { lines } = render(prs)
    expect(tasks(lines)).toEqual([`#1 ${LONG_TITLE}`])
    expect(lines).toContain(`merged: #2 ${LONG_TITLE}`)
    expect((boardJson(read(prs)).rows as Array<{ task: string }>).map(row => row.task)).toEqual([`#1 ${LONG_TITLE}`, `#2 ${LONG_TITLE}`])
  })

  it('reads a null inside statusCheckRollup as an unreadable --prs and still shows the board', () => {
    const { lines, exit } = render([pr(1, 'one', 'OPEN', [null])])
    expect(exit).toBe(0)
    expect(lines.join('\n')).toMatch(/prs .*prs\.json: unreadable \(entry 1 has a statusCheckRollup .*\)/)
  })

  it('sorts a time ahead of now as the newest in its bucket, not the oldest', () => {
    const prs = [pr(1, 'ahead', 'OPEN', [], { createdAt: at(2 * HOUR) }), pr(2, 'behind', 'OPEN', [], { createdAt: at(-HOUR) })]
    expect(tasks(render(prs).lines)).toEqual(['#2 behind', '#1 ahead'])
  })

  it('carries no reading or item field that nothing reads', () => {
    const reading = read([pr(1, 'one', 'OPEN', [])])
    expect(Object.keys(reading).sort()).toEqual(['implement', 'ledger', 'ledgerPresent', 'prs', 'view'])
    expect(Object.keys(reading.view.rows[0]!)).not.toContain('number')
  })

  it('exports from items and table only what another module imports', async () => {
    expect(Object.keys(await import('../../src/commands/board/items.js')).sort()).toEqual(['NO_NEXT', 'ladderItems', 'prItems'])
    expect(Object.keys(await import('../../src/commands/board/table.js')).sort()).toEqual(['formatAge', 'tableLines'])
  })
})
