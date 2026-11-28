import type { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { EITHER_JOURNAL, events, lastEventId } from '../../core/events-query.js'

export const BOARD_STAMP_FILE = 'board-stamp.js'
export const SECTION_FILE_PREFIX = 'board-section-'
export const FULL_BUILD_MS = 60_000
export const CARD_BUILD_EVENT_LIMIT = 500
const SECTION_HASH_DIGITS = 16
const SECTION_FILE = /^board-section-(.+)\.js$/

export type DialogPart = readonly [string, string]

export interface BuildPlan {
  kind: 'none' | 'cards' | 'full'
  cursor: number
  touched: ReadonlySet<number>
}

export interface SectionFiles {
  write: (file: string, text: string) => void
  remove?: (file: string) => void
  list?: (dir: string) => string[]
}

export function sectionFileOf(dir: string, name: string): string {
  return path.join(dir, `${SECTION_FILE_PREFIX}${name}.js`)
}

export function sectionHash(html: string): string {
  return createHash('sha256').update(html).digest('hex').slice(0, SECTION_HASH_DIGITS)
}

export function sectionScript(name: string, hash: string, html: string): string {
  return `window.BOARD_SECTION(${JSON.stringify(name)}, ${JSON.stringify(hash)}, ${JSON.stringify(html)})\n`
}

export class BuildCursor {
  private seen: number | null = null
  private fullAt = Number.NEGATIVE_INFINITY

  constructor(private readonly db: DatabaseSync) {}

  plan(nowMs: number): BuildPlan {
    const cursor = lastEventId(this.db)
    if (this.seen === null || nowMs - this.fullAt >= FULL_BUILD_MS)
      return { kind: 'full', cursor, touched: new Set() }
    if (cursor === this.seen)
      return { kind: 'none', cursor, touched: new Set() }
    const arrived = events(this.db, { since: this.seen, legacy: EITHER_JOURNAL, limit: CARD_BUILD_EVENT_LIMIT + 1 })
    if (arrived.length > CARD_BUILD_EVENT_LIMIT || arrived.some(event => event.card_id === null && event.pr !== null))
      return { kind: 'full', cursor, touched: new Set() }
    return { kind: 'cards', cursor, touched: new Set(arrived.flatMap(event => event.card_id === null ? [] : [event.card_id])) }
  }

  built(plan: BuildPlan, nowMs: number): void {
    this.seen = plan.cursor
    if (plan.kind === 'full')
      this.fullAt = nowMs
  }
}

export class CardCache<D> {
  private details = new Map<number, D>()
  private dialogs = new Map<number, string>()
  private cards = ''
  private stalls: string[] | null = null

  detailOf(plan: BuildPlan): (card: number) => D | undefined {
    return card => plan.kind === 'cards' && !plan.touched.has(card) ? this.details.get(card) : undefined
  }

  dialogOf(plan: BuildPlan, cards: readonly number[]): (card: number) => string | undefined {
    const same = cards.join(',') === this.cards
    return card => same && plan.kind === 'cards' && !plan.touched.has(card) ? this.dialogs.get(card) : undefined
  }

  stallsOf(plan: BuildPlan): (compute: () => string[]) => string[] {
    return (compute) => {
      if (this.stalls === null || plan.kind !== 'cards' || plan.touched.size > 0)
        this.stalls = compute()
      return this.stalls
    }
  }

  keep(details: ReadonlyMap<number, D>, dialogs: ReadonlyMap<number, string>): void {
    this.details = new Map(details)
    this.dialogs = new Map(dialogs)
    this.cards = [...details.keys()].join(',')
  }
}

export class SectionWriter {
  private readonly held = new Map<string, string>()
  private swept = false

  constructor(private readonly dir: string, private readonly files: SectionFiles) {}

  write(sections: ReadonlyMap<string, string>): Record<string, string> {
    const hashes = new Map([...sections].map(([name, html]) => [name, sectionHash(html)]))
    for (const [name, html] of [...sections].filter(([name]) => this.held.get(name) !== hashes.get(name)))
      this.files.write(sectionFileOf(this.dir, name), sectionScript(name, hashes.get(name)!, html))
    for (const name of this.leftOver(sections))
      this.files.remove?.(sectionFileOf(this.dir, name))
    this.held.clear()
    hashes.forEach((hash, name) => this.held.set(name, hash))
    this.swept = true
    return Object.fromEntries(hashes)
  }

  private leftOver(sections: ReadonlyMap<string, string>): string[] {
    const known = this.swept ? [...this.held.keys()] : (this.files.list?.(this.dir) ?? []).flatMap(file => SECTION_FILE.exec(file)?.slice(1, 2) ?? [])
    return known.filter(name => !sections.has(name))
  }
}
