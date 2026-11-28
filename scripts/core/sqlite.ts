import type { DatabaseSync, DatabaseSyncOptions } from 'node:sqlite'
import process from 'node:process'

export const SQLITE_EXPERIMENTAL_WARNING = 'SQLite is an experimental feature'

function isSqliteExperimental(warning: string | Error): boolean {
  return (typeof warning === 'string' ? warning : warning.message).startsWith(SQLITE_EXPERIMENTAL_WARNING)
}

function loadSqlite(): typeof import('node:sqlite') {
  const emitWarning = process.emitWarning
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    if (!isSqliteExperimental(warning))
      Reflect.apply(emitWarning, process, [warning, ...rest])
  }) as typeof process.emitWarning
  try {
    return process.getBuiltinModule('node:sqlite')
  }
  finally {
    process.emitWarning = emitWarning
  }
}

const sqlite = loadSqlite()

export function openDatabase(file: string, options: DatabaseSyncOptions = {}): DatabaseSync {
  return new sqlite.DatabaseSync(file, options)
}
