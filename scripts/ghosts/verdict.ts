import type { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { readContourSchema, violations } from '../contract/contours.js'
import { approvedHashPath, extractApprovedHash } from './approval.js'
import { appendJournalEvent } from './journal.js'

const JOURNAL_FILE = 'ghosts.jsonl'
const VERDICT_SCHEMA = 'review-verdict'
const JOURNAL_LINE = '#/$defs/journalLine'

interface Digest {
  path: string
  sha256: string
}

interface Verdict {
  task: string
  verdict: string
  head: string
  brief: Digest
  report: Digest
}

export type VerdictCheck
  = | { ok: true, line: Record<string, unknown> }
    | { ok: false, reasons: string[] }

function sha256OfBytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function readVerdict(verdictPath: string): Verdict | string {
  if (!existsSync(verdictPath))
    return `${verdictPath} does not exist`
  try {
    return JSON.parse(readFileSync(verdictPath, 'utf8')) as Verdict
  }
  catch (error) {
    return `${verdictPath} is not JSON: ${error instanceof Error ? error.message : String(error)}`
  }
}

function reportReasons(report: Digest, dir: string): string[] {
  const reportFile = path.resolve(dir, report.path)
  if (!existsSync(reportFile))
    return [`report.path ${report.path} does not exist`]
  const actual = sha256OfBytes(readFileSync(reportFile))
  return actual === report.sha256 ? [] : [`report.sha256 ${report.sha256} is not the sha256 of ${report.path} (${actual})`]
}

function briefReasons(brief: Digest, dir: string): string[] {
  const approvalFile = approvedHashPath(path.resolve(dir, brief.path))
  const name = path.basename(approvalFile)
  if (!existsSync(approvalFile))
    return [`brief.path ${brief.path} has no approval file ${name} next to it`]
  const approved = extractApprovedHash(readFileSync(approvalFile, 'utf8'))
  if (approved === undefined)
    return [`no approval hash in ${name}`]
  return approved === brief.sha256 ? [] : [`brief.sha256 ${brief.sha256} is not the approved hash in ${name} (${approved})`]
}

export function checkVerdict(verdictPath: string, dir: string, now: Date = new Date()): VerdictCheck {
  const verdict = readVerdict(verdictPath)
  if (typeof verdict === 'string')
    return { ok: false, reasons: [verdict] }
  const schema = readContourSchema(VERDICT_SCHEMA)
  const faults = violations(verdict, schema).map(fault => `${verdictPath}: ${fault}`)
  if (faults.length > 0)
    return { ok: false, reasons: faults }
  const reasons = [...reportReasons(verdict.report, dir), ...briefReasons(verdict.brief, dir)]
  if (reasons.length > 0)
    return { ok: false, reasons }
  const line = {
    event: 'review',
    ts: now.toISOString(),
    task: verdict.task,
    verdict: verdict.verdict,
    head: verdict.head,
    brief: verdict.brief,
    report: verdict.report,
    file: { path: path.relative(dir, verdictPath), sha256: sha256OfBytes(readFileSync(verdictPath)) },
  }
  const lineFaults = violations(line, { $ref: JOURNAL_LINE }, '', schema)
  return lineFaults.length > 0 ? { ok: false, reasons: lineFaults } : { ok: true, line }
}

export async function recordVerdict(verdictPath: string, dir: string): Promise<VerdictCheck> {
  const checked = checkVerdict(verdictPath, dir)
  if (checked.ok)
    await appendJournalEvent(path.join(dir, JOURNAL_FILE), checked.line)
  return checked
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({ args: process.argv.slice(2), allowPositionals: true, options: { dir: { type: 'string' } } })
  const verdictPath = positionals[0]
  if (verdictPath === undefined) {
    console.error('usage: verdict.ts <review-<task>.verdict.json> [--dir <handoff directory>]')
    process.exitCode = 1
    return
  }
  const checked = await recordVerdict(verdictPath, values.dir ?? path.dirname(verdictPath))
  if (checked.ok) {
    console.log(JSON.stringify(checked.line))
    return
  }
  for (const reason of checked.reasons)
    console.error(reason)
  process.exitCode = 1
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  await main()
