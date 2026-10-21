import type { DatabaseSync } from 'node:sqlite'
import type { Screen, Screens } from '../../src/commands/board/screens.js'
import { existsSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { busFacts } from '../../src/commands/board/bus.js'
import { boardScreens } from '../../src/commands/board/screens.js'
import { PLAIN_LORE } from '../../src/ui/lore.js'
import { BOARD_FILE } from './board.js'
import { BUSY_TIMEOUT_MS, defaultBusPath } from './db.js'
import { openDatabase } from './sqlite.js'

export const PREFIX = '[bus:board] '
export const REFRESH_SECONDS = 30

export interface BoardFiles {
  write: (file: string, text: string) => void
  rename: (from: string, to: string) => void
}

export const DISK_FILES: BoardFiles = {
  write: (file, text) => writeFileSync(file, text),
  rename: renameSync,
}

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }

export function escaped(text: string): string {
  return text.replace(/[&<>"']/g, char => ESCAPES[char]!)
}

function screenSection(screen: Screen): string {
  return `<section><h2>${escaped(screen.title)}</h2><pre>${screen.lines.map(escaped).join('\n')}</pre></section>`
}

const STYLE = `
:root { color-scheme: light dark; --gap: 1rem; }
body { font-family: ui-monospace, monospace; margin: 0; padding: var(--gap); display: grid; gap: var(--gap); grid-template-columns: repeat(auto-fit, minmax(min(36rem, 100%), 1fr)); }
header, footer { grid-column: 1 / -1; }
pre { margin: 0; white-space: pre-wrap; }
`

export function renderBoard(at: string, board: Screens): string {
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    `<meta http-equiv="refresh" content="${REFRESH_SECONDS}">`,
    `<title>construct board · ${escaped(at)}</title>`,
    `<style>${STYLE}</style></head><body>`,
    `<header><h1>construct board</h1><p>written ${escaped(at)}</p></header>`,
    ...board.screens.map(screenSection),
    `<footer><p>${escaped(board.footer)}</p></footer>`,
    '</body></html>',
    '',
  ].join('\n')
}

function pageOf(db: DatabaseSync, now: Date): string {
  return renderBoard(now.toISOString(), boardScreens(busFacts(db, now), PLAIN_LORE))
}

export function writeBoardPage(file: string, html: string, files: BoardFiles = DISK_FILES): void {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`)
  files.write(temporary, html)
  files.rename(temporary, file)
}

export function printBoard(busPath: string, now: Date, write: (text: string) => void): number {
  const db = openDatabase(busPath, { readOnly: true, timeout: BUSY_TIMEOUT_MS })
  try {
    write(pageOf(db, now))
    return 0
  }
  finally {
    db.close()
  }
}

export function runBoardCli(busPath: string = defaultBusPath()): number {
  if (!existsSync(busPath)) {
    console.error(`${PREFIX}no bus database at ${busPath}`)
    return 1
  }
  return printBoard(busPath, new Date(), text => process.stdout.write(text))
}

export interface BoardProjection {
  file: string
  project: (now: Date) => void
}

export function boardProjection(db: DatabaseSync, busPath: string): BoardProjection {
  const file = path.join(path.dirname(busPath), BOARD_FILE)
  return {
    file,
    project: (now) => {
      try {
        writeBoardPage(file, pageOf(db, now))
      }
      catch (error) {
        console.error(`${PREFIX}${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
      }
    },
  }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = runBoardCli()
