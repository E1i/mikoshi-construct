import type { BoardFiles } from '../../bus/board-page.js'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DISK_FILES, writeBoardPage } from '../../bus/board-page.js'
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
