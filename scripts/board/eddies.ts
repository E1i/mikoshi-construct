import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const EDDIES_JOURNAL = path.join('.construct', 'eddies.jsonl')
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

export function budgetSummary(window: BudgetLine[], tasks: BudgetLine[]): string[] {
  const count = (lines: BudgetLine[], event: BudgetLine['event']): number => lines.filter(line => line.event === event).length
  const all = [...window, ...tasks]
  if (all.length === 0)
    return []
  return [`eddies: budget-stop ${count(all, 'budget-stop')}, budget-warn ${count(all, 'budget-warn')}: window ${count(window, 'budget-stop')}/${count(window, 'budget-warn')}, tasks ${count(tasks, 'budget-stop')}/${count(tasks, 'budget-warn')} (stop/warn; .construct/eddies.jsonl)`]
}
