import type { Card } from '../../src/card/grammar.js'
import type { BuildRunner } from './hash.js'
import type { Preflight } from './preflight.js'
import { existsSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseParkingFile } from '../../src/card/parking.js'
import { riskReading } from '../../src/card/risk.js'
import { HANDOFF_DIR_VARIABLE } from '../board/run.js'
import { approvedHashPath, canonicalImplementText, cardNumberOf, checkApproval, extractApprovedHash, extractApprovedSketch, journalEvents, MORSE, revocationOf, revokeEvent } from './approval.js'
import { approvalLine, checkAcceptanceBuild, hashBrief, resolveApprover } from './hash.js'
import { appendJournalEvent } from './journal.js'
import { runPreflight } from './preflight.js'
import { readTasksFile } from './tasks.js'

const REVOKE_FLAG = '--revoke'
const BY_FLAG = '--by'
const USAGE = `usage: approve.ts | approve.ts <card> [${BY_FLAG} <name>] | approve.ts ${REVOKE_FLAG} <card>`
const RED_ON_BASE = /^red on (?:the )?base/i
const EXPECT_PREFIX = 'expect:'
const NOTHING_WAITS = 'no brief waits for the owner'

export interface QueuedBrief {
  card: Card
  brief: string
  journalPath: string
}

export interface WaitingBrief extends QueuedBrief {
  sha256: string
  risk: string
  why: string
  expect: string
  redOnBase: string[]
}

export interface ApproveOptions {
  handoffDir: string
  now: Date
  approver: string
  runBuild?: BuildRunner
  preflight?: Preflight
}

function queuedBriefs(handoffDir: string): QueuedBrief[] {
  const byCard = new Map<number, QueuedBrief>()
  readdirSync(handoffDir)
    .filter(file => /^tasks-.*\.json$/.test(file))
    .map(file => path.join(handoffDir, file))
    .sort((a, b) => statSync(a).mtime.getTime() - statSync(b).mtime.getTime())
    .forEach((file) => {
      const { out, tasks } = readTasksFile(file)
      for (const task of tasks)
        byCard.set(task.card.id, { card: task.card, brief: task.brief, journalPath: path.join(out, 'ghosts.jsonl') })
    })
  return [...byCard.values()]
}

function queuedBrief(handoffDir: string, card: number): QueuedBrief {
  const queued = queuedBriefs(handoffDir).find(entry => entry.card.id === card)
  if (queued === undefined)
    throw new Error(`no tasks file in ${handoffDir} names card #${card}`)
  return queued
}

function isApproved(queued: QueuedBrief): boolean {
  const approval = checkApproval(queued.brief)
  return approval.ok && revocationOf(journalEvents(queued.journalPath), approval.sha256, queued.card.id) === undefined
}

function riskOf(parkingDir: string, card: number): { risk: string, why: string } {
  const file = path.join(parkingDir, `${card}.md`)
  if (!existsSync(file))
    return { risk: 'not read', why: `no parking file ${file}` }
  const parsed = parseParkingFile(`${card}.md`, readFileSync(file, 'utf8'))
  if (parsed.kind === 'refused')
    return { risk: 'not read', why: parsed.reason }
  const reading = riskReading(parsed.parked.task.touches, false)
  return { risk: reading.level, why: reading.why }
}

function redOnBaseOf(content: string): string[] {
  const lines = content.split('\n')
  const start = lines.findIndex(line => RED_ON_BASE.test(line.trim()))
  if (start === -1)
    return []
  const first = lines.findIndex((line, index) => index > start && line.startsWith('|'))
  if (first === -1)
    return []
  const end = lines.findIndex((line, index) => index > first && !line.startsWith('|'))
  return lines.slice(first, end === -1 ? lines.length : end)
}

function waitingBrief(queued: QueuedBrief, parkingDir: string): WaitingBrief | undefined {
  if (!existsSync(queued.brief))
    return undefined
  const content = readFileSync(queued.brief, 'utf8')
  const text = canonicalImplementText(content)
  if (text === undefined || isApproved(queued))
    return undefined
  const { risk, why } = riskOf(parkingDir, queued.card.id)
  if (risk !== 'R1' && risk !== 'not read')
    return undefined
  const expect = text.split('\n').find(line => line.startsWith(EXPECT_PREFIX)) ?? `expect not recorded in ${queued.brief}`
  return { ...queued, sha256: hashBrief(queued.brief), risk, why, expect, redOnBase: redOnBaseOf(content) }
}

export function waitingBriefs(handoffDir: string, parkingDir: string): WaitingBrief[] {
  return queuedBriefs(handoffDir).flatMap(queued => waitingBrief(queued, parkingDir) ?? [])
}

export function renderWaiting(waiting: WaitingBrief[]): string[] {
  if (waiting.length === 0)
    return [NOTHING_WAITS]
  return waiting.flatMap(entry => [
    entry.card.line,
    `  risk: ${entry.risk} — ${entry.why}`,
    `  sha256: ${entry.sha256}`,
    `  ${entry.expect}`,
    `  brief: ${entry.brief}`,
    ...(entry.redOnBase.length === 0 ? [`  red on base: not in ${entry.brief}`] : ['  red on base:', ...entry.redOnBase.map(line => `  ${line}`)]),
  ])
}

export async function approveCard(card: number, options: ApproveOptions): Promise<string> {
  const { handoffDir, now, approver, runBuild = checkAcceptanceBuild, preflight = runPreflight } = options
  if (approver.trim().toLowerCase() === MORSE)
    throw new Error(`pnpm approve writes the owner's approval; ${MORSE} approves through pnpm ghosts:hash ${BY_FLAG} ${MORSE}`)
  const queued = queuedBrief(handoffDir, card)
  const sha256 = hashBrief(queued.brief)
  if (revocationOf(journalEvents(queued.journalPath), sha256, card) !== undefined)
    throw new Error(`the approval ${sha256} of card #${card} was revoked; change the brief text to approve it again`)
  const approvedPath = approvedHashPath(queued.brief)
  if (existsSync(approvedPath) && extractApprovedHash(readFileSync(approvedPath, 'utf8')) === sha256)
    throw new Error(`${approvedPath} already holds this hash; it is left as it is`)

  const line = approvalLine(queued.brief, now, approver, runBuild, preflight)
  await appendJournalEvent(queued.journalPath, {
    event: 'approval',
    by: approver,
    card,
    brief: path.resolve(queued.brief),
    sha256,
    sketch: extractApprovedSketch(line),
    ts: now.toISOString(),
  })
  writeFileSync(approvedPath, `${line}\n`)
  return line
}

export async function revokeCard(card: number, handoffDir: string, now: Date): Promise<string> {
  const queued = queuedBrief(handoffDir, card)
  const approvedPath = approvedHashPath(queued.brief)
  const sha256 = existsSync(approvedPath) ? extractApprovedHash(readFileSync(approvedPath, 'utf8')) : undefined
  if (sha256 === undefined)
    throw new Error(`card #${card}: no approval hash in ${approvedPath}, so nothing is revoked`)
  if (revocationOf(journalEvents(queued.journalPath), sha256, card) !== undefined)
    throw new Error(`card #${card}: the approval ${sha256} is already revoked`)
  await appendJournalEvent(queued.journalPath, revokeEvent(sha256, card, now.toISOString()))
  return `card #${card}: approval ${sha256.slice(0, 7)} revoked in ${queued.journalPath}`
}

type ApproveArgs
  = | { kind: 'list' }
    | { kind: 'approve', card: number, by: string | undefined }
    | { kind: 'revoke', card: number }

function cardArg(value: string | undefined): number {
  const card = value === undefined ? undefined : cardNumberOf(value)
  if (card === undefined)
    throw new Error(`expected a card number, got '${value ?? ''}'\n${USAGE}`)
  return card
}

export function approveArgs(argv: string[]): ApproveArgs {
  if (argv.length === 0)
    return { kind: 'list' }
  if (argv[0] === REVOKE_FLAG && argv.length === 2)
    return { kind: 'revoke', card: cardArg(argv[1]) }
  if (argv.length === 1)
    return { kind: 'approve', card: cardArg(argv[0]), by: undefined }
  if (argv.length === 3 && argv[1] === BY_FLAG)
    return { kind: 'approve', card: cardArg(argv[0]), by: argv[2] }
  throw new Error(USAGE)
}

function constructDir(name: string): string {
  return path.join(os.homedir(), '.construct', name)
}

async function main(): Promise<void> {
  const handoffDir = process.env[HANDOFF_DIR_VARIABLE] ?? constructDir('handoff')
  try {
    const args = approveArgs(process.argv.slice(2))
    if (args.kind === 'list')
      console.log(renderWaiting(waitingBriefs(handoffDir, constructDir('parking'))).join('\n'))
    else if (args.kind === 'revoke')
      console.log(await revokeCard(args.card, handoffDir, new Date()))
    else
      console.log(await approveCard(args.card, { handoffDir, now: new Date(), approver: resolveApprover(args.by) }))
  }
  catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  await main()
