import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

export type ApprovalCheck
  = | { ok: true, text: string, sha256: string, approvedSketch: string }
    | { ok: false, reason: string }

export function extractImplementText(content: string): string | undefined {
  const index = content.search(/^\/implement /m)
  if (index === -1)
    return undefined
  return content.slice(index)
}

export function canonicalImplementText(content: string): string | undefined {
  const text = extractImplementText(content)
  if (text === undefined)
    return undefined
  return text.replace(/\n+$/, '')
}

const SKETCH_LINE_PREFIX = 'Sketch: '
const APPROVED_SKETCH = /sketch:\s*(none|[0-9a-f]{40})(?![0-9a-f])/

export function withoutSketchLine(text: string): string {
  const lines = text.split('\n')
  if (lines[1]?.startsWith(SKETCH_LINE_PREFIX))
    lines.splice(1, 1)
  return lines.join('\n')
}

export function implementLineNumbers(content: string): number[] {
  const numbers: number[] = []
  const lines = content.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].startsWith('/implement '))
      numbers.push(index + 1)
  }
  return numbers
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

export function approvalSha256(canonicalText: string): string {
  return sha256Hex(withoutSketchLine(canonicalText))
}

export function approvedHashPath(briefPath: string): string {
  return `${briefPath.replace(/\.md$/, '')}.approved-sha256`
}

export function extractApprovedHash(content: string): string | undefined {
  const match = /sha256:\s*([0-9a-f]{64})/.exec(content)
  return match?.[1]
}

export function extractApprovedSketch(content: string): string | undefined {
  return APPROVED_SKETCH.exec(content)?.[1]
}

export function checkApproval(briefPath: string): ApprovalCheck {
  const content = readFileSync(briefPath, 'utf8')

  const lineNumbers = implementLineNumbers(content)
  if (lineNumbers.length > 1) {
    return {
      ok: false,
      reason: `${briefPath}: more than one line starts with '/implement ' (lines ${lineNumbers.join(', ')})`,
    }
  }

  const text = canonicalImplementText(content)
  if (text === undefined)
    return { ok: false, reason: `${briefPath}: no line starting with '/implement ' in the brief` }

  const approvedPath = approvedHashPath(briefPath)
  if (!existsSync(approvedPath))
    return { ok: false, reason: `${briefPath}: no approval file ${path.basename(approvedPath)} next to the brief` }

  const approvedContent = readFileSync(approvedPath, 'utf8')
  const expected = extractApprovedHash(approvedContent)
  if (expected === undefined)
    return { ok: false, reason: `${briefPath}: no approval hash in ${path.basename(approvedPath)}` }

  const approvedSketch = extractApprovedSketch(approvedContent)
  if (approvedSketch === undefined)
    return { ok: false, reason: `${briefPath}: ${path.basename(approvedPath)} names no 'sketch: <40-hex sha|none>': it was written when the Sketch: line was part of the hash; re-approve the brief with pnpm ghosts:hash` }

  const actual = approvalSha256(text)
  if (actual !== expected) {
    return {
      ok: false,
      reason: `${briefPath}: the /implement text does not match the approved hash (approved ${expected}, actual ${actual})`,
    }
  }

  return { ok: true, text, sha256: expected, approvedSketch }
}

export type JournalEvent = Record<string, unknown>

export const MORSE = 'morse'

const CARD_NUMBER = /^#?(\d+)$/
const SHA256_LINE = /sha256:\s*[0-9a-f]{64}/
const CLOSING_APPROVER = /\(\d{4}-\d{2}-\d{2}, (.*)\)\s*$/

export function cardNumberOf(value: string): number | undefined {
  const match = CARD_NUMBER.exec(value)
  return match === null ? undefined : Number(match[1])
}

export function approverOf(content: string): string | undefined {
  const line = content.split('\n').find(text => SHA256_LINE.test(text))
  const approver = line === undefined ? undefined : CLOSING_APPROVER.exec(line)?.[1]?.trim()
  return approver === undefined || approver === '' ? undefined : approver
}

export function journalEvents(journalPath: string): JournalEvent[] {
  if (!existsSync(journalPath))
    return []
  return readFileSync(journalPath, 'utf8').split('\n').flatMap((text) => {
    try {
      const event = JSON.parse(text) as unknown
      return event !== null && typeof event === 'object' && !Array.isArray(event) ? [event as Record<string, unknown>] : []
    }
    catch {
      return []
    }
  })
}

export function fallsOf(events: JournalEvent[], card: number): string[] {
  return events.flatMap(event => event.event === 'fall' && event.card === card && typeof event.kind === 'string' ? [event.kind] : [])
}

export interface ApprovalFields {
  card: number
  brief: string
  sha256: string
  sketch: string
  risk: string
  reason: string
  forecast: object
  ts: string
}

export function approvalEvent(fields: ApprovalFields): JournalEvent {
  return {
    event: 'approval',
    by: MORSE,
    card: fields.card,
    brief: fields.brief,
    sha256: fields.sha256,
    sketch: fields.sketch,
    risk: fields.risk,
    reason: fields.reason,
    forecast: fields.forecast,
    ts: fields.ts,
  }
}

export function morseApprovalOf(events: JournalEvent[], sha256: string, card: number): JournalEvent | undefined {
  return events.find(event => event.event === 'approval' && event.by === MORSE && event.sha256 === sha256 && event.card === card)
}

export function revokeEvent(sha256: string, card: number, ts: string): JournalEvent {
  return { event: 'revoke', sha256, card, ts }
}

export function revocationOf(events: JournalEvent[], sha256: string, card: number): JournalEvent | undefined {
  return events.find(event => event.event === 'revoke' && event.sha256 === sha256 && event.card === card)
}
