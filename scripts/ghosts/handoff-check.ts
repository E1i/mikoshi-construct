import { existsSync, readFileSync, realpathSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

export const PREFIX = '[handoff:check] '

export interface HandoffField {
  id: string
  label: string
  group: 'where we are' | 'what continuing needs' | 'how to verify' | 'what must not be lost'
}

export const HANDOFF_FIELDS: readonly HandoffField[] = [
  { id: 'current-card', label: 'current card', group: 'where we are' },
  { id: 'queue', label: 'queue', group: 'where we are' },
  { id: 'done', label: 'done', group: 'where we are' },
  { id: 'not-done', label: 'not done', group: 'where we are' },
  { id: 'journal', label: 'journal', group: 'what continuing needs' },
  { id: 'card-paths', label: 'card paths', group: 'what continuing needs' },
  { id: 'cloud-runs', label: 'cloud runs', group: 'what continuing needs' },
  { id: 'delegation', label: 'delegation', group: 'what continuing needs' },
  { id: 'local-decisions', label: 'local decisions', group: 'what continuing needs' },
  { id: 'judge-format', label: 'judge format', group: 'how to verify' },
  { id: 'gates', label: 'gates', group: 'how to verify' },
  { id: 'owner-waits', label: 'owner waits', group: 'how to verify' },
  { id: 'owner-decisions', label: 'owner decisions', group: 'what must not be lost' },
  { id: 'intake-tokens', label: 'intake tokens', group: 'what must not be lost' },
  { id: 'probe-results', label: 'probe results', group: 'what must not be lost' },
  { id: 'stop-reason', label: 'stop reason', group: 'what must not be lost' },
  { id: 'continue-when', label: 'continue when', group: 'what must not be lost' },
]

const HEADING = /^#{1,6} +(\S.*)$/
const LIST_MARKERS = /^(?:(?:[-*+]|\d+[.)])\s+)+/
const PLACEHOLDER = /^(?:[\p{P}\p{S}\s]*|\s*(?:tbd|todo)\s*)$/iu

function normalised(label: string): string {
  return label.toLowerCase().replace(/[*_`]/g, '').trim().replace(LIST_MARKERS, '').replace(/:$/, '').trim()
}

function labelled(line: string): { label: string, value: string } | null {
  const colon = line.indexOf(':')
  if (colon < 0)
    return null
  const label = normalised(line.slice(0, colon))
  return { label, value: line.slice(colon + 1).trim() }
}

function valuesOf(text: string): Map<string, string> {
  const values = new Map<string, string>()
  const lines = text.split(/\r?\n/)
  let heading: string | null = null
  const add = (label: string, value: string): void => {
    values.set(label, `${values.get(label) ?? ''}${value}`)
  }
  for (const line of lines) {
    const head = HEADING.exec(line)
    if (head !== null) {
      heading = normalised(head[1])
      add(heading, '')
      continue
    }
    const field = labelled(line)
    if (field !== null && HANDOFF_FIELDS.some(known => known.label === field.label)) {
      add(field.label, field.value)
      continue
    }
    if (heading !== null)
      add(heading, line.trim())
  }
  return values
}

export function missingFields(text: string): HandoffField[] {
  const values = valuesOf(text)
  return HANDOFF_FIELDS.filter(field => PLACEHOLDER.test(values.get(field.label) ?? ''))
}

export function refusal(missing: readonly HandoffField[]): string[] {
  return missing.map(field => `${PREFIX}missing: ${field.label} (${field.id}, ${field.group})`)
}

export interface HandoffCheckDeps {
  exists: (file: string) => boolean
  read: (file: string) => string
  out: (line: string) => void
  err: (line: string) => void
}

export function runHandoffCheck(args: string[], deps: HandoffCheckDeps): number {
  const [file, ...rest] = args
  if (file === undefined || rest.length > 0) {
    deps.err(`${PREFIX}usage: handoff-check.ts <handoff file>`)
    return 2
  }
  if (!deps.exists(file)) {
    deps.err(`${PREFIX}no handoff at ${file}`)
    return 1
  }
  const missing = missingFields(deps.read(file))
  if (missing.length > 0) {
    for (const line of refusal(missing))
      deps.err(line)
    deps.err(`${PREFIX}${file} is not a handoff: ${missing.length} of ${HANDOFF_FIELDS.length} fields missing`)
    return 1
  }
  deps.out(`${PREFIX}${file}: all ${HANDOFF_FIELDS.length} fields present`)
  return 0
}

const isEntry = process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
if (isEntry) {
  process.exitCode = runHandoffCheck(process.argv.slice(2), {
    exists: existsSync,
    read: file => readFileSync(file, 'utf8'),
    out: line => process.stdout.write(`${line}\n`),
    err: line => process.stderr.write(`${line}\n`),
  })
}
