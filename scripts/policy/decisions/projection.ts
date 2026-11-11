import type { DatabaseSync } from 'node:sqlite'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { openBus } from '../../core/db.js'
import { reduce } from '../../core/reducer.js'
import { ARCHIVE_HEADER, runDecisionsAdd } from './add.js'
import { decisionsFileOf, PREFIX, projectDecisions } from './decisions.js'
import { decisionsIntake } from './import.js'
import { busProjectsDecisions, decisionRows, expireDecisions, recordDecision, recordedNumbers, startProjectingDecisions } from './index.js'
import { archiveOf } from './read.js'

export type DecisionsAdder = (args: string[]) => { code: number, lines: string[] }

export type DecisionsSettler = () => void

function readIfThere(file: string): string {
  return existsSync(file) ? readFileSync(file, 'utf8') : ''
}

function writeIfChanged(file: string, before: string, after: string): void {
  if (after !== before)
    writeFileSync(file, after)
}

export function decisionsSettler(db: DatabaseSync, decisions: string, now: () => Date): DecisionsSettler {
  return () => {
    if (!busProjectsDecisions(db)) {
      decisionsIntake(db, decisions, now)()
      startProjectingDecisions(db, now())
    }
    reduce(db)
    expireDecisions(db, now())
    reduce(db)
    const archive = archiveOf(decisions)
    const [file, archived] = [readIfThere(decisions), readIfThere(archive)]
    const projected = projectDecisions(decisionRows(db), file, archived, ARCHIVE_HEADER)
    try {
      writeIfChanged(archive, archived, projected.archive)
      writeIfChanged(decisions, file, projected.file)
    }
    catch (error) {
      console.error(`${PREFIX}${decisions} not rebuilt: ${error instanceof Error ? error.message : String(error)}; the next tick tries again`)
    }
  }
}

export function decisionsAdder(db: DatabaseSync, decisions: string, now: () => Date): DecisionsAdder {
  return (args) => {
    const lines: string[] = []
    const code = runDecisionsAdd(args, {
      decisions,
      now,
      exists: existsSync,
      read: file => readFileSync(file, 'utf8'),
      write: (file, text) => writeFileSync(file, text),
      remove: unlinkSync,
      record: decision => recordDecision(db, decision),
      held: () => recordedNumbers(db),
      settled: () => false,
      out: line => lines.push(line),
      err: line => lines.push(line),
    })
    return { code, lines }
  }
}

export function decisionsSettlerOfBus(db: DatabaseSync, busPath: string, now: () => Date): DecisionsSettler {
  return decisionsSettler(db, decisionsFileOf(busPath), now)
}

export function decisionsAdderOfBus(db: DatabaseSync, busPath: string, now: () => Date): DecisionsAdder {
  return decisionsAdder(db, decisionsFileOf(busPath), now)
}

export function projectionText(busPath: string): string {
  const file = decisionsFileOf(busPath)
  return existsSync(file) ? readFileSync(file, 'utf8') : ''
}

export function decisionsAdderOpeningTheBus(busPath: string, now: () => Date): DecisionsAdder {
  return (args) => {
    const file = decisionsFileOf(busPath)
    if (!existsSync(file))
      writeFileSync(file, '')
    const db = openBus(busPath)
    try {
      return decisionsAdder(db, file, now)(args)
    }
    finally {
      db.close()
    }
  }
}
