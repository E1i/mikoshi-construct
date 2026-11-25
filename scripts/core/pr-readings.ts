import type { DatabaseSync, SQLInputValue } from 'node:sqlite'

export interface PrRow {
  pr: number
  card_id: number | null
  base: string | null
  head: string | null
  state: string | null
  mergeable: string | null
  ci: string | null
  verdict_on_head: string | null
  auto_merge: number | null
  draft: number | null
  event_id: number
  body_sha: string | null
}

type StoredPr = Record<keyof PrRow, SQLInputValue>

const PR_COLUMNS = 'pr, card_id, base, head, state, mergeable, ci, verdict_on_head, auto_merge, draft, event_id, body_sha'

function numberOrNull(value: SQLInputValue): number | null {
  return value === null ? null : Number(value)
}

function textOrNull(value: SQLInputValue): string | null {
  return value === null ? null : String(value)
}

function prOfRow(row: StoredPr): PrRow {
  return {
    pr: Number(row.pr),
    card_id: numberOrNull(row.card_id),
    base: textOrNull(row.base),
    head: textOrNull(row.head),
    state: textOrNull(row.state),
    mergeable: textOrNull(row.mergeable),
    ci: textOrNull(row.ci),
    verdict_on_head: textOrNull(row.verdict_on_head),
    auto_merge: numberOrNull(row.auto_merge),
    draft: numberOrNull(row.draft),
    event_id: Number(row.event_id),
    body_sha: textOrNull(row.body_sha),
  }
}

function selected(db: DatabaseSync, where: string, ...values: SQLInputValue[]): PrRow[] {
  return (db.prepare(`SELECT ${PR_COLUMNS} FROM prs ${where} ORDER BY pr`).all(...values) as StoredPr[]).map(prOfRow)
}

export function ofPr(db: DatabaseSync, pr: number): PrRow | null {
  return selected(db, 'WHERE pr = ?', pr)[0] ?? null
}

export function ofCard(db: DatabaseSync, cardId: number): PrRow[] {
  return selected(db, 'WHERE card_id = ?', cardId)
}

export function all(db: DatabaseSync): PrRow[] {
  return selected(db, '')
}

export interface MainsSinceMechanics {
  mechanics: string
  shas: Set<string>
}

const LAST_MECHANICS_MAIN = 'SELECT sha, event_id FROM mains WHERE touches_mechanics = 1 ORDER BY event_id DESC LIMIT 1'
const MAINS_FROM = 'SELECT sha FROM mains WHERE event_id >= ?'

export function mainsSinceLastMechanics(db: DatabaseSync): MainsSinceMechanics | null {
  const last = db.prepare(LAST_MECHANICS_MAIN).get() as { sha: string, event_id: number } | undefined
  if (last === undefined)
    return null
  const shas = (db.prepare(MAINS_FROM).all(last.event_id) as { sha: string }[]).map(row => String(row.sha))
  return { mechanics: String(last.sha), shas: new Set(shas) }
}

export function mergedCards(db: DatabaseSync): number[] {
  return (db.prepare(`SELECT DISTINCT card_id FROM prs WHERE state = 'merged' AND card_id IS NOT NULL ORDER BY card_id`).all() as { card_id: number }[]).map(row => Number(row.card_id))
}

export function latestQuestionStops(stopsWithTheirCard: string, columns: string, condition: string): string {
  return `
  SELECT ${columns} FROM ${stopsWithTheirCard}
  LEFT JOIN prs ON prs.pr = coalesce(stop.pr, cards.pr)
  WHERE (prs.pr IS NULL OR prs.state = 'open')
    AND ${condition}
  ORDER BY stop.card_id
`
}

export function openPrsWhere(columns: string, condition: string): string {
  return `
  SELECT ${columns} FROM prs
  WHERE state = 'open' AND ${condition}
  ORDER BY pr
`
}

const PR_HEAD = 'SELECT head FROM prs WHERE pr = ?'

export function headOf(db: DatabaseSync, pr: number): string | null {
  const row = db.prepare(PR_HEAD).get(pr) as { head: string | null } | undefined
  return row?.head ?? null
}
