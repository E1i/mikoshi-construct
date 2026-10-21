import type { BoardFiles } from '../../bus/board-page.js'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { busReaderAt } from '../../../src/commands/board/bus.js'
import { printBoard as printConstructBoard, readBoard } from '../../../src/commands/board/index.js'
import { createUi } from '../../../src/ui/console.js'
import { resolveTheme } from '../../../src/ui/theme.js'
import { checkMatrix, subagent, writeBus } from '../../../tests/board/bus-fixture.js'
import { DISK_FILES, escaped, printBoard, writeBoardPage } from '../../bus/board-page.js'
import { BOARD_FILE } from '../../bus/board.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

describe('writeBoardPage', () => {
  it('the board is built in a temporary file and renamed over board.html', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bus-board-page-'))
    roots.push(root)
    const board = path.join(root, BOARD_FILE)
    writeFileSync(board, '<p>the previous board</p>')
    const calls: string[][] = []
    const files: BoardFiles = {
      write: (file, text) => {
        calls.push(['write', file])
        expect(readFileSync(board, 'utf8')).toBe('<p>the previous board</p>')
        DISK_FILES.write(file, text)
      },
      rename: (from, to) => {
        calls.push(['rename', from, to])
        DISK_FILES.rename(from, to)
      },
    }
    writeBoardPage(board, '<p>the next board</p>', files)
    const temporary = calls[0]![1]!
    expect(calls).toEqual([['write', temporary], ['rename', temporary, board]])
    expect(temporary).not.toBe(board)
    expect(path.dirname(temporary)).toBe(root)
    expect(readFileSync(board, 'utf8')).toBe('<p>the next board</p>')
    expect(existsSync(temporary)).toBe(false)
    expect(readdirSync(root)).toEqual([BOARD_FILE])
  })
})

describe('board.html', () => {
  const NOW = new Date('2026-10-20T08:00:00.000Z')

  function minutesAgo(minutes: number): string {
    return new Date(NOW.getTime() - minutes * 60_000).toISOString()
  }

  function seededBus(): string {
    const root = mkdtempSync(path.join(tmpdir(), 'bus-board-screens-'))
    roots.push(root)
    return writeBus(path.join(root, 'bus.db'), {
      cards: [
        { id: 860, state: 'queued', lane: 'lane-1', line: 'card: #860 first <task>', since: minutesAgo(30) },
        { id: 861, state: 'running', lane: 'lane-1', line: '#861 second', since: minutesAgo(20) },
        { id: 862, state: 'in_review', lane: 'lane-2', line: null, since: minutesAgo(10), pr: 12 },
        { id: 863, state: 'merged', lane: null, line: '#863 done', since: minutesAgo(5) },
      ],
      verdicts: [[12, null]],
      tasks: [{ queue: 'review', card: 862, pr: 12, head: 'abcdef1234567', state: 'leased' }],
      roles: [{ role: 'operator', status: 'idle', state: 'awake' }],
      events: [
        { ts: minutesAgo(1), type: 'netwatch.tick', card: null, payload: '{}' },
        subagent(minutesAgo(2), { role: 'implementer', task: '#861', session: 's1', tree: '/trees/mc-861', step: 'writing' }),
        checkMatrix(12, 'abcdef1234567', { killed: 3, survived: 1, notRun: 0 }),
      ],
    })
  }

  function constructBoardLines(busPath: string): string[] {
    let out = ''
    const ui = createUi(resolveTheme({ plain: true }), (text) => {
      out += text
    })
    printConstructBoard(ui, readBoard(path.dirname(busPath), { all: false, staleHours: 4, prs: undefined, readStdin: () => '', now: NOW, bus: busReaderAt(busPath, () => NOW) }))
    return out.trimEnd().split('\n')
  }

  function pageText(busPath: string): string {
    let html = ''
    expect(printBoard(busPath, NOW, (text) => {
      html += text
    })).toBe(0)
    return html
  }

  it('board.html and construct board rendered from one bus snapshot show the same screens and lines as construct board', () => {
    const busPath = seededBus()
    const lines = constructBoardLines(busPath)
    const html = pageText(busPath)
    expect(lines).toContain('in work (1): #861')
    expect([...html.matchAll(/<h2>(.*?)<\/h2>/g)].map(match => match[1])).toEqual(['Flow', 'Backlog', 'Services'])
    const screens = [...html.matchAll(/<h2>(.*?)<\/h2><pre>([\s\S]*?)<\/pre>/g)].flatMap(match => [match[1]!, ...match[2]!.split('\n')])
    const footer = /<footer><p>(.*?)<\/p><\/footer>/.exec(html)?.[1]
    expect([...screens, footer]).toEqual(lines.map(escaped))
  })

  it('the page reads liveness from the bus pulse and lists no process', () => {
    const html = pageText(seededBus())
    expect(html).toContain('bus · pulse · — · pulse 1 min ago · slots in use: review 1')
    expect(html).not.toContain('pid ')
    expect(html).not.toContain('<h2>Health</h2>')
  })
})
