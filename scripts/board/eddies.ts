import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const EDDIES_JOURNAL = path.join('.construct', 'eddies.jsonl')
const EDDIES_LIMITS = path.join('.claude', 'eddies.json')
const BUDGET_EVENTS = ['budget-stop', 'budget-warn'] as const

export interface BudgetLine {
  event: typeof BUDGET_EVENTS[number]
  level: string
  spent: number
  limit: number
  tool: string | null
  at: string
  session: string
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '?'
}

function amount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : Number.NaN
}

function budgetOf(line: string): BudgetLine[] {
  try {
    const entry = JSON.parse(line) as Record<string, unknown> | null
    const event = BUDGET_EVENTS.find(name => name === entry?.event)
    if (entry == null || event === undefined)
      return []
    return [{ event, level: text(entry.level), spent: amount(entry.spent), limit: amount(entry.limit), tool: typeof entry.tool === 'string' ? entry.tool : null, at: text(entry.at), session: text(entry.session_id) }]
  }
  catch {
    return []
  }
}

export function readBudgetLines(dir: string | undefined): BudgetLine[] {
  if (dir === undefined)
    return []
  const file = path.join(dir, EDDIES_JOURNAL)
  try {
    return existsSync(file) ? readFileSync(file, 'utf8').split('\n').flatMap(budgetOf) : []
  }
  catch {
    return []
  }
}

export function budgetText(line: BudgetLine): string {
  return `${line.event} ${line.level} ${Math.round(line.spent)} / ${line.limit}${line.tool === null ? '' : ` on ${line.tool}`} (${line.at}, session ${line.session})`
}

export interface ContextLimits {
  contextLimit: number
  warnRatio: number
}

export interface Eddies {
  context: number | undefined
  stop: number
  warn: number
}

export function readContextLimits(repoRoot: string | undefined): ContextLimits | undefined {
  if (repoRoot === undefined)
    return undefined
  try {
    const { contextLimit, warnRatio } = JSON.parse(readFileSync(path.join(repoRoot, EDDIES_LIMITS), 'utf8')) as Record<string, unknown>
    return typeof contextLimit === 'number' && contextLimit > 0 && typeof warnRatio === 'number' ? { contextLimit, warnRatio } : undefined
  }
  catch {
    return undefined
  }
}

export function contextPercent(context: number, limits: ContextLimits): number {
  return Math.round(context / limits.contextLimit * 100)
}

export function eddiesOf(context: number | undefined, lines: BudgetLine[]): Eddies {
  return { context, stop: lines.filter(line => line.event === 'budget-stop').length, warn: lines.filter(line => line.event === 'budget-warn').length }
}

export function eddiesText(eddies: Eddies, limits: ContextLimits | undefined): string {
  const parts = [
    eddies.context === undefined || limits === undefined ? undefined : `ctx ${contextPercent(eddies.context, limits)}%`,
    eddies.stop === 0 ? undefined : `stop ${eddies.stop}`,
    eddies.warn === 0 ? undefined : `warn ${eddies.warn}`,
  ].filter(part => part !== undefined)
  return parts.length === 0 ? '—' : parts.join(' · ')
}
