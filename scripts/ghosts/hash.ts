import type { Card } from '../../src/card/grammar.js'
import type { JournalEvent } from './approval.js'
import type { Expect } from './expect.js'
import type { Preflight } from './preflight.js'
import type { Sketch } from './sketch.js'
import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os, { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseParkingFile } from '../../src/card/parking.js'
import { riskReading } from '../../src/card/risk.js'
import { UNCLEAR_PREFIX, WITNESSES_HEADING } from '../../src/commands/intake/slice.js'
import { HANDOFF_DIR_VARIABLE } from '../board/run.js'
import { approvalEvent, approvalSha256, approvedHashPath, canonicalImplementText, cardNumberOf, carriedReason, contourSuggestion, fallsOf, journalEvents, MORSE, morseCarryOf, revocationOf, suggestionEvent } from './approval.js'
import { parseExpect } from './expect.js'
import { appendJournalEvent } from './journal.js'
import { pinnedBaseAtCwd, runPreflight } from './preflight.js'
import { parseSketch } from './sketch.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')
const CHECK_ACCEPTANCE = path.join(REPO_ROOT, 'scripts/construct/check-acceptance.mjs')
const BY_FLAG = '--by'
const CARD_FLAG = '--card'
const PARKING_FLAG = '--parking'
const USAGE = `usage: hash.ts <brief> [${BY_FLAG} <name>] | hash.ts <brief> ${BY_FLAG} ${MORSE} ${CARD_FLAG} <card> [${PARKING_FLAG} <dir>]`
const APPROVER_NOT_RECORDED = `approver not recorded: pass ${BY_FLAG} or set git config user.name`

export interface BuildResult { status: number | null, stderr: string, stdout?: string }
export type BuildRunner = (implementTextPath: string) => BuildResult

export function checkAcceptanceBuild(implementTextPath: string): BuildResult {
  const result = spawnSync(process.execPath, [CHECK_ACCEPTANCE, 'build', '--brief', implementTextPath], { cwd: REPO_ROOT, encoding: 'utf8' })
  return { status: result.status, stderr: result.error?.message ?? result.stderr, stdout: result.stdout }
}

function implementTextOf(briefPath: string): string {
  const text = canonicalImplementText(readFileSync(briefPath, 'utf8'))
  if (text === undefined)
    throw new Error(`${briefPath}: no line starting with '/implement ' in the brief`)
  return text
}

export function hashBrief(briefPath: string): string {
  return approvalSha256(implementTextOf(briefPath))
}

function firstBuildError(stderr: string): string {
  return stderr.split('\n').find(line => line.trim() !== '')?.trim() ?? 'no error printed'
}

function refuseUnlessBuilt(briefPath: string, text: string, runBuild: BuildRunner): BuildResult {
  const dir = mkdtempSync(path.join(tmpdir(), 'ghosts-hash-build-'))
  try {
    const implementTextPath = path.join(dir, 'implement.md')
    writeFileSync(implementTextPath, text)
    const result = runBuild(implementTextPath)
    if (result.status !== 0)
      throw new Error(`${briefPath}: check-acceptance build exited ${result.status ?? 'without a status'} on the /implement text, so no hash is printed: ${firstBuildError(result.stderr)}`)
    return result
  }
  finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export const PREFLIGHT_EVENT = 'preflight'

export interface PreflightMemory {
  journalPath: string
  base: () => string
  log: (line: string) => void
  now: () => Date
}

function passedOn(events: JournalEvent[], sha256: string, base: string): boolean {
  return events.some(event => event.event === PREFLIGHT_EVENT && event.sha256 === sha256 && event.base === base && event.ok === true)
}

export function rememberedPreflight(preflight: Preflight, memory: PreflightMemory): Preflight {
  return (input) => {
    const sha256 = approvalSha256(input.text)
    const base = memory.base()
    if (passedOn(journalEvents(memory.journalPath), sha256, base)) {
      memory.log(`preflight: base ${base.slice(0, 7)}; green on this text and base in ${memory.journalPath}, not run again`)
      return
    }
    preflight({ ...input, base })
    mkdirSync(path.dirname(memory.journalPath), { recursive: true })
    appendFileSync(memory.journalPath, `${JSON.stringify({ event: PREFLIGHT_EVENT, sha256, base, ok: true, ts: memory.now().toISOString() })}\n`)
  }
}

function journalPreflight(): Preflight {
  return rememberedPreflight(runPreflight, { journalPath: handoffJournalPath(), base: pinnedBaseAtCwd, log: line => console.error(line), now: () => new Date() })
}

function approvedSketchOf(sketch: Sketch): string {
  return sketch.kind === 'branch' ? sketch.sha : 'none'
}

function localDate(now: Date): string {
  return [now.getFullYear(), now.getMonth() + 1, now.getDate()].map(part => String(part).padStart(2, '0')).join('-')
}

export function gitUserName(): string {
  try {
    return execFileSync('git', ['config', 'user.name'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  }
  catch {
    return ''
  }
}

export function resolveApprover(by: string | undefined, readGitName: () => string = gitUserName): string {
  const approver = (by ?? '').trim() || readGitName().trim()
  if (approver === '')
    throw new Error(APPROVER_NOT_RECORDED)
  return approver
}

function lineOf(briefPath: string, text: string, now: Date, approver: string, runBuild: BuildRunner, preflight: Preflight): string {
  const built = refuseUnlessBuilt(briefPath, text, runBuild)
  preflight({ briefPath, text, sketch: parseSketch(text), buildStdout: built.stdout ?? '' })
  return `approved /implement text sha256: ${approvalSha256(text)} sketch: ${approvedSketchOf(parseSketch(text))} (${localDate(now)}, ${approver})`
}

export function approvalLine(briefPath: string, now: Date, approver: string, runBuild: BuildRunner = checkAcceptanceBuild, preflight: Preflight = runPreflight): string {
  return lineOf(briefPath, implementTextOf(briefPath), now, approver, runBuild, preflight)
}

type Forecast = Extract<Expect, { kind: 'forecast' }>

export interface MorseOptions {
  card: number
  parkingDir: string
  journalPath: string
  now: Date
  runBuild?: BuildRunner
  preflight?: Preflight
}

export interface MorseApproval {
  line: string
  suggestion?: string
}

function parkedCard(parkingDir: string, card: number): { card: Card, touches: string[], body: string } {
  const file = path.join(parkingDir, `${card}.md`)
  if (!existsSync(file))
    throw new Error(`no parking file ${file} for card #${card}; the card is read from there before anything is built`)
  const parsed = parseParkingFile(`${card}.md`, readFileSync(file, 'utf8'))
  if (parsed.kind === 'refused')
    throw new Error(`card #${card}: ${parsed.reason}`)
  return parsed.parked.task
}

export function cardProseIn(text: string, body: string): string[] {
  const lines = body.split('\n')
  const witnesses = lines.findIndex(line => line.trim() === WITNESSES_HEADING)
  const prose = (witnesses === -1 ? lines : lines.slice(0, witnesses)).map(line => line.trim()).filter(line => line !== '')
  return prose.filter(line => text.includes(line))
}

function refuseCardProse(text: string, card: number, body: string): void {
  const restated = cardProseIn(text, body)
  if (restated.length > 0)
    throw new Error(`the /implement text restates card #${card} verbatim (${restated.map(line => `'${line}'`).join(', ')}), so MORSE does not approve; reference the card as #${card} and keep the sketch and the steps`)
}

function bandedForecast(text: string): { forecast: Forecast, p75: number } {
  let expected: Expect | null
  try {
    expected = parseExpect(text)
  }
  catch (error) {
    throw new Error(`the expect: line cannot be read, so MORSE does not approve: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (expected === null)
    throw new Error('the /implement text has no expect: line, so MORSE does not approve; the brief waits for the owner')
  if (expected.kind === 'none')
    throw new Error(`the expect: line is none (${expected.reason}), so MORSE does not approve; the brief waits for the owner`)
  if (expected.band === undefined)
    throw new Error('the expect: forecast has no p25–p75 band, so MORSE does not approve; the brief waits for the owner')
  if (expected.tokens > expected.band.p75)
    throw new Error(`the expect: forecast ${expected.tokens} tokens is above its p75 ${expected.band.p75}, so MORSE does not approve; the brief waits for the owner`)
  return { forecast: expected, p75: expected.band.p75 }
}

function carriedSketch(briefPath: string, sha256: string, sketch: string, events: JournalEvent[], card: number): string | undefined {
  const approvedPath = approvedHashPath(briefPath)
  const carry = morseCarryOf(existsSync(approvedPath) ? readFileSync(approvedPath, 'utf8') : undefined, sha256, sketch, events, card)
  if (carry.kind === 'refused')
    throw new Error(`${approvedPath} ${carry.reason}`)
  return carry.kind === 'carry' ? carry.from : undefined
}

export async function morseApprove(briefPath: string, options: MorseOptions): Promise<MorseApproval> {
  const { card, parkingDir, journalPath, now, runBuild = checkAcceptanceBuild, preflight = runPreflight } = options
  const text = implementTextOf(briefPath)
  const sha256 = approvalSha256(text)
  const parked = parkedCard(parkingDir, card)

  const reading = riskReading(parked.touches, false)
  if (parked.body.split('\n').some(line => line.startsWith(UNCLEAR_PREFIX.trimEnd())))
    throw new Error(`card #${card} has an unclear field, so MORSE does not approve; the brief waits for the owner`)
  refuseCardProse(text, card, parked.body)
  const events = journalEvents(journalPath)
  const falls = fallsOf(events, card)
  if (falls.length >= 1)
    throw new Error(`card #${card} fell ${falls.length} time(s) (${falls.join(', ')}), so MORSE does not approve; the brief waits for the owner`)
  if (revocationOf(events, sha256, card) !== undefined)
    throw new Error(`the approval ${sha256} of card #${card} was revoked, so MORSE does not approve it; change the brief text to approve it again`)
  const { forecast, p75 } = bandedForecast(text)
  const sketch = approvedSketchOf(parseSketch(text))
  const carriedFrom = carriedSketch(briefPath, sha256, sketch, events, card)

  const line = lineOf(briefPath, text, now, MORSE, runBuild, preflight)
  const event = approvalEvent({
    card,
    brief: path.resolve(briefPath),
    sha256,
    sketch,
    risk: reading.level,
    reason: `risk ${reading.level} (${reading.why}), forecast ${forecast.tokens} tokens within p75 ${p75}, 0 falls, no unclear field${carriedFrom === undefined ? '' : `, ${carriedReason(carriedFrom)}`}`,
    forecast,
    ts: now.toISOString(),
    carriedFrom,
  })
  const suggestion = contourSuggestion(parked.card, forecast)
  try {
    await appendJournalEvent(journalPath, event)
    if (suggestion !== undefined)
      await appendJournalEvent(journalPath, suggestionEvent(card, suggestion, now.toISOString()))
  }
  catch (error) {
    throw new Error(`the journal ${journalPath} cannot be written (${error instanceof Error ? error.message : String(error)}), so no approval file was written`)
  }
  writeFileSync(approvedHashPath(briefPath), `${line}\n`)
  return suggestion === undefined ? { line } : { line, suggestion }
}

interface HashArgs {
  briefPath: string
  by: string | undefined
  card: string | undefined
  parking: string | undefined
}

function flagValue(argv: string[], flag: string): { at: number, value: string | undefined } {
  return { at: argv.indexOf(flag), value: argv[argv.indexOf(flag) + 1] }
}

function hashArgs(argv: string[]): HashArgs | string {
  const flags = [BY_FLAG, CARD_FLAG, PARKING_FLAG].map(flag => ({ flag, ...flagValue(argv, flag) }))
  const taken = new Set<number>()
  for (const { flag, at, value } of flags) {
    if (at === -1)
      continue
    if (value === undefined || (flag === PARKING_FLAG && value.startsWith('-')) || argv.includes(flag, at + 1))
      return `${flag} needs one value\n${USAGE}`
    taken.add(at)
    taken.add(at + 1)
  }
  const positional = argv.filter((_, index) => !taken.has(index))
  if (positional.length !== 1)
    return USAGE
  const [by, card, parking] = flags.map(({ value, at }) => at === -1 ? undefined : value)
  const morse = by !== undefined && by.trim().toLowerCase() === MORSE
  if (morse && card === undefined)
    return `${BY_FLAG} ${MORSE} needs ${CARD_FLAG}\n${USAGE}`
  if (!morse && card !== undefined)
    return `${CARD_FLAG} needs ${BY_FLAG} ${MORSE}\n${USAGE}`
  if (!morse && parking !== undefined)
    return `${PARKING_FLAG} needs ${BY_FLAG} ${MORSE}\n${USAGE}`
  if (card !== undefined && cardNumberOf(card) === undefined)
    return `${CARD_FLAG}: expected a card number, got '${card}'\n${USAGE}`
  return { briefPath: positional[0]!, by, card, parking }
}

export function handoffJournalPath(): string {
  return path.join(process.env[HANDOFF_DIR_VARIABLE] ?? path.join(os.homedir(), '.construct', 'handoff'), 'ghosts.jsonl')
}

export function parkingDirOf(parking: string | undefined): string {
  return parking === undefined ? path.join(os.homedir(), '.construct', 'parking') : path.resolve(parking)
}

async function main(): Promise<void> {
  const args = hashArgs(process.argv.slice(2))
  if (typeof args === 'string') {
    console.error(args)
    process.exitCode = 1
    return
  }

  try {
    if (args.card !== undefined) {
      const approval = await morseApprove(args.briefPath, { card: cardNumberOf(args.card)!, parkingDir: parkingDirOf(args.parking), journalPath: handoffJournalPath(), now: new Date(), preflight: journalPreflight() })
      console.log(approval.line)
      if (approval.suggestion !== undefined)
        console.log(approval.suggestion)
      return
    }
    console.log(approvalLine(args.briefPath, new Date(), resolveApprover(args.by), checkAcceptanceBuild, journalPreflight()))
  }
  catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  await main()
