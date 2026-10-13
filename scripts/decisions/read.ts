import type { BusCardStates } from '../../src/card/closed.js'
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { closedTasks, mergedTasks } from '../../src/card/closed.js'
import { defaultBusPath } from '../bus/db.js'
import { busCardStates } from '../ghosts/tasks.js'
import { decisionsFindings, decisionsRefusals, inForce, parseDecisions, PREFIX, settleSupersedes, spendDecisions } from './decisions.js'

export const USAGE = 'usage: pnpm decisions [<owner-decisions.md>]'

export interface DecisionsReadDeps {
  home: string
  exists: (file: string) => boolean
  journal: string
  bus: BusCardStates
  read: (file: string) => string
  write: (file: string, text: string) => void
  out: (line: string) => void
  err: (line: string) => void
  finding?: (line: string) => void
}

export function defaultDecisions(home: string): string {
  return path.join(home, '.construct', 'owner-decisions.md')
}

export function archiveOf(file: string): string {
  return file.replace(/(?:\.md)?$/, '.archive.md')
}

export function journalOf(home: string, handoffDir: string | undefined): string {
  return path.join(handoffDir ?? path.join(home, '.construct', 'handoff'), 'ghosts.jsonl')
}

function settledCards(journalText: string, bus: BusCardStates): Set<number> {
  const settled = [...closedTasks(journalText, bus).keys(), ...mergedTasks(journalText, bus)]
  return new Set(settled.filter(task => /^[1-9]\d*$/.test(task)).map(Number))
}

export function runDecisionsRead(args: string[], deps: DecisionsReadDeps): number {
  if (args.length > 1 || args[0]?.startsWith('--')) {
    deps.err(`${PREFIX}${USAGE}`)
    return 2
  }
  const file = args[0] ?? defaultDecisions(deps.home)
  if (!deps.exists(file)) {
    deps.err(`${PREFIX}no decisions at ${file}`)
    return 1
  }
  const read = deps.read(file)
  const settled = settledCards(deps.exists(deps.journal) ? deps.read(deps.journal) : '', deps.bus)
  const archiveFile = archiveOf(file)
  const archive = deps.exists(archiveFile) ? deps.read(archiveFile) : ''
  const text = settleSupersedes(spendDecisions(read, card => settled.has(card)), archive)
  if (text !== read)
    deps.write(file, text)
  const refusals = decisionsRefusals(text, archive)
  if (refusals.length > 0) {
    for (const line of refusals)
      deps.err(line)
    deps.err(`${PREFIX}${file} refused: ${refusals.length} refusals, no decision read`)
    return 1
  }
  for (const decision of inForce(parseDecisions(text).decisions))
    deps.out(decision.text)
  for (const line of decisionsFindings(text))
    deps.finding?.(line)
  return 0
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runDecisionsRead(process.argv.slice(2), {
    home: os.homedir(),
    journal: journalOf(os.homedir(), process.env.CONSTRUCT_HANDOFF_DIR),
    bus: busCardStates(defaultBusPath()),
    exists: existsSync,
    read: file => readFileSync(file, 'utf8'),
    write: (file, text) => writeFileSync(file, text),
    out: line => console.log(line),
    err: line => console.error(line),
    finding: line => console.error(line),
  })
}
