import { DatabaseSync } from 'node:sqlite'
import { WatchRefusal } from './watch-refusal.js'

export const ONCE_STORE = 'miko-watch.db'
export const ANOTHER_CONSUMER = 'another consumer already waits'
const SQLITE_BUSY = 5
const WINNER_COMMIT_WAIT_MS = 5000

export interface WatchCursor {
  offset: number
  busId: number
}

export interface LegacyCursor {
  file: string
  text: string | undefined
}

export interface Opened { kind: 'stored' | 'migrated' | 'initialized', cursor: WatchCursor }

export function parseLegacyCursor(text: string): WatchCursor | undefined {
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null)
      return undefined
    const { offset, busId } = parsed as { offset?: unknown, busId?: unknown }
    return Number.isSafeInteger(offset) && Number.isSafeInteger(busId) && (offset as number) >= 0 && (busId as number) >= 0
      ? { offset: offset as number, busId: busId as number }
      : undefined
  }
  catch {
    return undefined
  }
}

function busy(error: unknown): boolean {
  return (error as { errcode?: unknown }).errcode === SQLITE_BUSY
}

function storedCursor(db: DatabaseSync): WatchCursor | undefined {
  const row = db.prepare('SELECT journal_offset, bus_id FROM cursor WHERE id = 1').get() as { journal_offset: number, bus_id: number } | undefined
  return row === undefined ? undefined : { offset: Number(row.journal_offset), busId: Number(row.bus_id) }
}

function firstCursor(legacy: LegacyCursor, ends: () => WatchCursor): Opened {
  if (legacy.text === undefined)
    return { kind: 'initialized', cursor: ends() }
  const cursor = parseLegacyCursor(legacy.text)
  if (cursor === undefined)
    throw new WatchRefusal(`miko:watch: the old cursor ${legacy.file} is not {"offset": <n ≥ 0>, "busId": <n ≥ 0>}: ${JSON.stringify(legacy.text.slice(0, 200))}`)
  return { kind: 'migrated', cursor }
}

export class OnceStore {
  private constructor(private readonly db: DatabaseSync, readonly file: string, readonly opened: Opened) {}

  static open(file: string, legacy: LegacyCursor, ends: () => WatchCursor): OnceStore {
    let db: DatabaseSync | undefined
    try {
      db = new DatabaseSync(file)
      db.exec('PRAGMA busy_timeout = 0')
      db.exec('PRAGMA locking_mode = EXCLUSIVE')
      db.exec('BEGIN IMMEDIATE')
      db.exec(`PRAGMA busy_timeout = ${WINNER_COMMIT_WAIT_MS}`)
      db.exec('CREATE TABLE IF NOT EXISTS cursor (id INTEGER PRIMARY KEY CHECK (id = 1), journal_offset INTEGER NOT NULL CHECK (journal_offset >= 0), bus_id INTEGER NOT NULL CHECK (bus_id >= 0))')
      const stored = storedCursor(db)
      const opened: Opened = stored === undefined ? firstCursor(legacy, ends) : { kind: 'stored', cursor: stored }
      if (stored === undefined)
        db.prepare('INSERT INTO cursor (id, journal_offset, bus_id) VALUES (1, ?, ?)').run(opened.cursor.offset, opened.cursor.busId)
      db.exec('COMMIT')
      return new OnceStore(db, file, opened)
    }
    catch (error) {
      db?.close()
      if (error instanceof WatchRefusal)
        throw error
      throw new WatchRefusal(busy(error)
        ? `miko:watch: ${ANOTHER_CONSUMER} on ${file}`
        : `miko:watch: ${file} cannot be opened as the --once cursor: ${(error as Error).message}`)
    }
  }

  openedLine(): string {
    const { kind, cursor } = this.opened
    const at = `journal offset ${cursor.offset}, bus id ${cursor.busId}`
    if (kind === 'initialized')
      return `no cursor: initialized at ${at}; earlier events are not delivered`
    return kind === 'migrated' ? `miko:watch: the cursor moved into ${this.file} at ${at}` : `miko:watch: the cursor in ${this.file} is at ${at}`
  }

  cursor(): WatchCursor {
    try {
      const cursor = storedCursor(this.db)
      if (cursor === undefined)
        throw new Error('the cursor row is gone')
      return cursor
    }
    catch (error) {
      throw new WatchRefusal(`miko:watch: the cursor in ${this.file} cannot be read: ${(error as Error).message}`)
    }
  }

  write(cursor: WatchCursor): void {
    this.db.exec('BEGIN')
    this.db.prepare('UPDATE cursor SET journal_offset = ?, bus_id = ? WHERE id = 1').run(cursor.offset, cursor.busId)
  }

  commit(): void {
    this.db.exec('COMMIT')
  }

  close(): void {
    this.db.close()
  }
}
