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

export function ofPr(db: DatabaseSync, pr: number): PrRow | null {
  const row = db.prepare(`SELECT ${PR_COLUMNS} FROM prs WHERE pr = ?`).get(pr) as StoredPr | undefined
  return row === undefined ? null : prOfRow(row)
}

export function ofCard(db: DatabaseSync, cardId: number): PrRow[] {
  return (db.prepare(`SELECT ${PR_COLUMNS} FROM prs WHERE card_id = ? ORDER BY pr`).all(cardId) as StoredPr[]).map(prOfRow)
}
