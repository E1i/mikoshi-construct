import type { DatabaseSync } from 'node:sqlite'
import type { BoardFiles } from '../../bus/board-page.js'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DISK_FILES, printBoard, writeBoardPage } from '../../bus/board-page.js'
import { BOARD_FILE } from '../../bus/board.js'
import { appendEvent, openBus } from '../../bus/db.js'
import { NODE_EQUIVALENCE } from '../../bus/node.js'
import { WORKERS_FILE } from '../../bus/workers.js'

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

describe('printBoard', () => {
  const NOW = new Date('2026-10-20T08:00:00.000Z')

  function minutesAgo(minutes: number): string {
    return new Date(NOW.getTime() - minutes * 60_000).toISOString()
  }

  function equivalence(db: DatabaseSync, worker: string, ts: string): void {
    appendEvent(db, { ts, type: NODE_EQUIVALENCE, actor: `worker:${worker}:s-${worker}`, cardId: null, pr: null, head: null, dedupeKey: `${NODE_EQUIVALENCE}:${worker}:${ts}`, payload: { same: [] }, legacy: false })
  }

  it('the board prints its full output when ps fails with EPERM, and a worker with no event for 3 minutes is shown dead', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bus-board-print-'))
    roots.push(root)
    const busPath = path.join(root, 'bus.db')
    const db = openBus(busPath)
    equivalence(db, 'review', minutesAgo(3))
    equivalence(db, 'merge', minutesAgo(1))
    db.close()
    writeFileSync(path.join(root, WORKERS_FILE), `${JSON.stringify({ on: ['review', 'merge', 'update'] })}\n`)
    const ps = (): never => {
      throw Object.assign(new Error('spawnSync ps EPERM'), { code: 'EPERM' })
    }
    let html = ''
    expect(printBoard(busPath, NOW, (text) => {
      html += text
    }, ps)).toBe(0)
    expect(html).toContain('</html>')
    for (const section of ['Queue', 'Lanes', 'Execution', 'Health', 'Bus contract v1'])
      expect(html).toContain(`<h2>${section}</h2>`)
    expect(html).toContain('<tr><td>review</td><td data-tone="red">down</td>')
    expect(html).toContain('<tr><td>merge</td><td data-tone="green">alive</td>')
    expect(html).toContain('<tr><td>update</td><td data-tone="red">down</td>')
    expect(html).toContain(`no node event since 3 min ago`)
    expect(html).toContain(`${NODE_EQUIVALENCE} 1 min ago`)
  })
})
