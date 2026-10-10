import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { decisionsRefusals, inForce, parseDecisions, PREFIX, spendDecisions } from './decisions.js'

export const USAGE = 'usage: pnpm decisions [<owner-decisions.md>]'

export interface DecisionsReadDeps {
  home: string
  exists: (file: string) => boolean
  journal: string
  read: (file: string) => string
  write: (file: string, text: string) => void
  out: (line: string) => void
  err: (line: string) => void
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

function journalLines(text: string): Record<string, unknown>[] {
  return text.split('\n').flatMap((line) => {
    try {
      const entry: unknown = JSON.parse(line)
      return typeof entry === 'object' && entry !== null ? [entry as Record<string, unknown>] : []
    }
    catch {
      return []
    }
  })
}

function settledCards(journalText: string): Set<number> {
  const settled = new Set<number>()
  for (const entry of journalLines(journalText)) {
    const merged = entry.event === 'merge'
    const closed = entry.event === 'path' && (entry.report !== undefined || entry.verification !== undefined)
    if ((merged || closed) && typeof entry.task === 'string' && /^[1-9]\d*$/.test(entry.task))
      settled.add(Number(entry.task))
  }
  return settled
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
  const settled = settledCards(deps.exists(deps.journal) ? deps.read(deps.journal) : '')
  const text = spendDecisions(read, card => settled.has(card))
  if (text !== read)
    deps.write(file, text)
  const archive = archiveOf(file)
  const refusals = decisionsRefusals(text, deps.exists(archive) ? deps.read(archive) : '')
  if (refusals.length > 0) {
    for (const line of refusals)
      deps.err(line)
    deps.err(`${PREFIX}${file} refused: ${refusals.length} refusals, no decision read`)
    return 1
  }
  for (const decision of inForce(parseDecisions(text).decisions))
    deps.out(decision.text)
  return 0
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runDecisionsRead(process.argv.slice(2), {
    home: os.homedir(),
    journal: journalOf(os.homedir(), process.env.CONSTRUCT_HANDOFF_DIR),
    exists: existsSync,
    read: file => readFileSync(file, 'utf8'),
    write: (file, text) => writeFileSync(file, text),
    out: line => console.log(line),
    err: line => console.error(line),
  })
}
