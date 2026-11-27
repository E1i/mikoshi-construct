import type { DatabaseSync } from 'node:sqlite'
import { realpathSync } from 'node:fs'
import os from 'node:os'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { defaultBusPath, openBus } from '../../core/db.js'
import { REQUEST_DONE, REQUEST_REFUSED } from '../../core/events.js'
import { ownerChannelOfBus, sayToOwnerChannel } from '../../owner/channel.js'
import { OWNER_SOURCE, PREFIX } from './decisions.js'
import { continueFixesDecisionOf, namesPrAtHead, observedHeadsOf } from './read.js'
import { runRequest, SESSION_VARIABLE } from './window-door.js'
import { ADD_COMMAND, CARD_FLAG, CARD_REFERENCE, FILE_FLAG, parseArgs, SETTLED_FLAG, sourceRefusal, SUPERSEDES_FLAG, UNTIL_FLAG } from './writer.js'

export { ARCHIVE_HEADER, lockFileOf, planAdd, runDecisionsAdd, takeFileLock } from './writer.js'

export const OWNER_SHELL_USAGE = `usage: ${ADD_COMMAND} [${SUPERSEDES_FLAG} D-M]... [${CARD_FLAG} #N]... [--creates <path>]... [${UNTIL_FLAG} <YYYY-MM-DDTHH:MMZ>] "[owner] <decision>"`
const FLAGS_THE_BUS_KEEPS = [FILE_FLAG, SETTLED_FLAG]

const OWNER_SHELL_SESSION = 'owner-shell'
const CREATES_FLAG = '--creates'
const PR_AT_A_SHA = new RegExp(`^(?:${OWNER_SOURCE.replace(/[[\]]/g, '\\$&')} )?\\S+ PR #([1-9]\\d*) at ([0-9a-f]+)(?![0-9a-f])`, 'i')
const ANY_FULL_HEAD = '0'.repeat(40)

export type WindowRequestRun = (argv: readonly string[], db: DatabaseSync, now: Date, session: string, out: (line: string) => void) => number

export function splitCreates(args: readonly string[]): { creates: string[], rest: string[] } {
  const creates: string[] = []
  const rest: string[] = []
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index + 1]
    if (args[index] === CREATES_FLAG && value !== undefined && !value.startsWith('--')) {
      creates.push(value)
      index += 1
    }
    else {
      rest.push(args[index]!)
    }
  }
  return { creates, rest }
}

function cardsNamed(args: readonly string[]): number[] {
  return args.flatMap((arg, index) => {
    const value = args[index + 1]
    return arg === CARD_FLAG && value !== undefined && CARD_REFERENCE.test(value) ? [Number(CARD_REFERENCE.exec(value)![1])] : []
  })
}

function decidesAtHead(text: string, pr: number, head: string): boolean {
  return namesPrAtHead(text, pr, head) || continueFixesDecisionOf([{ decisionId: 0, text, cards: [] }], pr, head, []) !== null
}

function closestHeadHint(sha: string, pr: number, heads: readonly string[], atHead: (head: string) => string): string {
  const extending = [...new Set(heads.filter(head => head.startsWith(sha.toLowerCase())))]
  if (extending.length === 1)
    return `the full head is ${extending[0]}: write "${atHead(extending[0]!)}"`
  if (extending.length > 1)
    return `${extending.length} observed heads of PR #${pr} start with ${sha}; name the full one`
  return heads.length === 0 ? `the bus observed no head of PR #${pr}` : `the latest observed head of PR #${pr} is ${heads.at(-1)}`
}

export function roundLimitHeadRefusal(text: string, observedHeads: (pr: number) => readonly string[]): string | null {
  const named = PR_AT_A_SHA.exec(text)
  if (named === null)
    return null
  const pr = Number(named[1])
  const sha = named[2]!
  const shaAt = named[0].length - sha.length
  const atHead = (head: string): string => `${text.slice(0, shaAt)}${head}${text.slice(named[0].length)}`
  if (!decidesAtHead(atHead(ANY_FULL_HEAD), pr, ANY_FULL_HEAD))
    return null
  const heads = observedHeads(pr)
  if (heads.includes(sha))
    return null
  return `${PREFIX}${sha} is not a full observed head of PR #${pr}: the bus reads an allow-merge or continue-fixes record only at a full 40-hex head it observed, so this one would never be answered; ${closestHeadHint(sha, pr, heads, atHead)}; nothing requested`
}

function headRefusalIn(args: readonly string[], db: DatabaseSync): string | null {
  return args.filter(arg => !arg.startsWith('--')).map(arg => roundLimitHeadRefusal(arg.trim(), pr => observedHeadsOf(db, pr))).find(refusal => refusal !== null) ?? null
}

function requestWidening(db: DatabaseSync, cards: readonly number[], creates: readonly string[], now: Date, session: string, out: (line: string) => void, run: WindowRequestRun): boolean {
  const change = creates.map(file => `+${file}`).join(',')
  return cards.every(card => run(['amend', '--card', String(card), '--touches', change, '--auto-confirm'], db, now, session, out) === 0)
}

export function requestDecision(args: readonly string[], db: DatabaseSync, now: Date, session: string, out: (line: string) => void, run: WindowRequestRun): number {
  const { creates, rest } = splitCreates(args)
  const headRefusal = headRefusalIn(rest, db)
  if (headRefusal !== null) {
    out(headRefusal)
    return 1
  }
  if (creates.length > 0) {
    const cards = cardsNamed(rest)
    if (cards.length === 0) {
      out(`${PREFIX}${CREATES_FLAG} names a file a card's decision requires and needs --card; nothing requested`)
      return 2
    }
    if (!requestWidening(db, cards, creates, now, session, out, run))
      return 1
  }
  const lines: string[] = []
  const code = run(['decisions:add', ...rest], db, now, session, line => lines.push(line))
  for (const line of lines)
    out(line)
  if (code === 0)
    out(`${PREFIX}not written yet: ${lines[0]?.match(/window\.request \d+/)?.[0] ?? 'the request'} waits for bus:run, which records it in the bus, rebuilds owner-decisions.md from the bus and answers ${REQUEST_DONE} or ${REQUEST_REFUSED}; while bus:run is down nothing is written`)
  return code
}

export function requestFromOwnerShell(args: string[], channel: string, db: DatabaseSync, now: Date, out: (line: string) => void, err: (line: string) => void, run: WindowRequestRun): number {
  const { rest } = splitCreates(args)
  const parsed = parseArgs(rest)
  if (parsed === null || FLAGS_THE_BUS_KEEPS.some(flag => rest.includes(flag))) {
    err(`${PREFIX}${OWNER_SHELL_USAGE}`)
    return 2
  }
  const source = sourceRefusal(parsed.text)
  if (source !== null) {
    err(source)
    return 1
  }
  const headRefusal = headRefusalIn([parsed.text], db)
  if (headRefusal !== null) {
    err(headRefusal)
    return 1
  }
  sayToOwnerChannel(channel, parsed.text.slice(OWNER_SOURCE.length), now)
  return requestDecision(['--from', 'answer', ...args], db, now, OWNER_SHELL_SESSION, out, run)
}

export function withOwnerShellBus(run: (db: DatabaseSync, channel: string) => number): number {
  const busPath = defaultBusPath()
  const db = openBus(busPath)
  try {
    return run(db, ownerChannelOfBus(os.homedir(), busPath))
  }
  finally {
    db.close()
  }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const windowSession = process.env[SESSION_VARIABLE]?.trim()
  if (windowSession) {
    const db = openBus(defaultBusPath())
    try {
      process.exitCode = requestDecision(args, db, new Date(), windowSession, line => console.log(line), runRequest)
    }
    finally {
      db.close()
    }
  }
  else {
    process.exitCode = withOwnerShellBus((db, channel) => requestFromOwnerShell(args, channel, db, new Date(), line => console.log(line), line => console.error(line), runRequest))
  }
}
