import type { IntakeOptions, IntakeResult } from '../src/commands/intake/index.js'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { INTAKE_EXIT, printIntake, runIntake } from '../src/commands/intake/index.js'
import { createUi, silentWriter } from '../src/ui/console.js'
import { resolveTheme } from '../src/ui/theme.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

interface World { root: string, parking: string, journal: string, draft: string }

function world(cards: Record<string, unknown>[]): World {
  const root = mkdtempSync(path.join(tmpdir(), 'intake-confirm-'))
  roots.push(root)
  const draft = path.join(root, 'draft.json')
  writeFileSync(draft, JSON.stringify({ cards }))
  return { root, parking: path.join(root, 'parking'), journal: path.join(root, 'ghosts.jsonl'), draft }
}

function card(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return { name: 'gate-card', kind: 'implement', milestone: 'runner', size: 'S', contour: 'cheap', decision: 'owner', who: 'shift', touches: ['src/a.ts'], task: 'Gate the card.', witnesses: ['`pnpm run quality` is green'], ...fields }
}

function intake(w: World, options: Partial<IntakeOptions> = {}): IntakeResult {
  return runIntake({ draft: w.draft, taken: '-', parking: w.parking, journal: w.journal, dryRun: false, autoConfirm: false, readStdin: () => '12', ...options })
}

function journalLines(w: World): Record<string, unknown>[] {
  return existsSync(w.journal) ? readFileSync(w.journal, 'utf8').trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>) : []
}

function printed(result: IntakeResult): { lines: string[], exit: number } {
  const lines: string[] = []
  const exit = printIntake(createUi(resolveTheme({ plain: true }), line => lines.push(line)), result)
  return { lines, exit }
}

const CORRECTION = 'number — #12 → #13 — #12 is taken by a pull request or issue listed in --taken; numbers are assigned by construct intake'

describe('intake confirmation gate', () => {
  it('without --auto-confirm a corrected card is not parked and nothing is journaled until a person confirms the list it printed', () => {
    const w = world([card({ number: 12 })])
    const held = intake(w)
    expect(held.status).toBe('awaiting')
    expect(existsSync(path.join(w.parking, '13.md'))).toBe(false)
    expect(journalLines(w)).toEqual([])
    const { lines, exit } = printed(held)
    expect(exit).toBe(INTAKE_EXIT.awaiting)
    expect(lines.join('\n')).toContain(`corrected: ${CORRECTION}`)
    const token = held.status === 'awaiting' ? held.token : ''
    expect(lines.at(-1)).toContain(`--confirm ${token}`)

    const confirmed = intake(w, { confirm: token })
    expect(confirmed.status).toBe('written')
    const text = readFileSync(path.join(w.parking, '13.md'), 'utf8')
    expect(text).toContain(`corrected: ${CORRECTION}`)
    expect(text).toContain('who: shift')
    expect(journalLines(w)).toMatchObject([{ event: 'intake', task: '13', confirmation: 'person', corrections: [CORRECTION] }])
  })

  it('a --confirm token that names another list parks nothing and prints the list this run holds', () => {
    const w = world([card({ number: 12 })])
    const result = intake(w, { confirm: 'not-the-token' })
    expect(result).toMatchObject({ status: 'awaiting', stale: true })
    expect(existsSync(w.parking)).toBe(false)
    expect(printed(result).lines[0]).toContain('--confirm names a different list of corrections')
  })

  it('with --auto-confirm a corrected card is parked at once and its corrections and the flag are written to the journal', () => {
    const w = world([card({ number: 12 }), card({ name: 'clean-card' })])
    const result = intake(w, { autoConfirm: true })
    expect(result.status).toBe('written')
    expect(printed(result).exit).toBe(INTAKE_EXIT.written)
    expect(readFileSync(path.join(w.parking, '13.md'), 'utf8')).toContain('who: shift')
    expect(journalLines(w)).toMatchObject([
      { event: 'intake', task: '13', confirmation: 'auto', corrections: [CORRECTION] },
      { event: 'intake', task: '14', confirmation: 'auto', corrections: [] },
    ])
  })

  it('a draft with no correction is parked without a confirmation and journaled as needing none', () => {
    const w = world([card()])
    const result = intake(w)
    expect(result.status).toBe('written')
    expect(journalLines(w)).toMatchObject([{ event: 'intake', task: '13', confirmation: 'none', corrections: [] }])
  })

  it('--dry-run neither parks nor journals, whatever the corrections', () => {
    const w = world([card({ number: 12 })])
    expect(intake(w, { dryRun: true }).status).toBe('dryRun')
    expect(existsSync(w.parking)).toBe(false)
    expect(journalLines(w)).toEqual([])
    printIntake(createUi(resolveTheme({ plain: true }), silentWriter), intake(w, { dryRun: true }))
  })
})
