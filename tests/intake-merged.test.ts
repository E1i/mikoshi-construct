import type { IntakeResult } from '../src/commands/intake/index.js'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { printIntake, runIntake } from '../src/commands/intake/index.js'
import { createUi } from '../src/ui/console.js'
import { resolveTheme } from '../src/ui/theme.js'

const TASK = 'The intake should read a depends as met only once its pull request is merged.'
const DONE = { event: 'path', task: '77', path: 'cheap', pr: 537, verification: 'run' }
const MERGED = { event: 'merge', task: '77', pr: 537, by: 'owner', commit: 'abc', merged: '2026-10-05T00:00:00Z' }
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function scratch(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'intake-merged-'))
  roots.push(root)
  return root
}

function journalOf(...lines: object[]): string {
  const file = path.join(scratch(), 'ghosts.jsonl')
  writeFileSync(file, lines.map(line => `${JSON.stringify(line)}\n`).join(''))
  return file
}

function parkedCardText(journal: string, fields: Record<string, unknown>): { text: string, output: string } {
  const root = scratch()
  const parking = path.join(root, 'parking')
  mkdirSync(parking)
  writeFileSync(path.join(parking, '13.md'), '')
  const draft = path.join(root, 'draft.json')
  const card = { name: 'merge-card', kind: 'implement', milestone: 'runner', size: 'S', contour: 'cheap', decision: 'owner', touches: ['src/a.ts'], task: TASK, witnesses: ['`pnpm run quality` is green'], ...fields }
  writeFileSync(draft, JSON.stringify({ cards: [card] }))
  const result: IntakeResult = runIntake({ draft, parking, dir: root, journal, dryRun: false, autoConfirm: true, readStdin: () => '12', taken: '-' })
  if (result.status === 'refused')
    throw new Error(`refused: ${result.refusal} ${result.detail.join('; ')}`)
  const lines: string[] = []
  printIntake(createUi(resolveTheme({ plain: true }), line => lines.push(line)), result)
  return { text: readFileSync(path.join(parking, '14.md'), 'utf8'), output: lines.join('\n') }
}

describe('a depends or blocks is met by a merge line, not by a done task', () => {
  it('keeps a depends on a task done but not merged and removes it once a merge line names it', () => {
    const open = parkedCardText(journalOf(DONE), { depends: ['#77'] })
    expect(open.text).toMatch(/^card: #14 \S+ \[.*\] · depends #77 · blocks —$/m)
    expect(open.output).not.toContain('corrected: depends')
    expect(open.text).not.toContain('unclear: depends')
    const merged = parkedCardText(journalOf(DONE, MERGED), { depends: ['#77'] })
    expect(merged.text).toMatch(/^card: #14 \S+ \[.*\] · depends — · blocks —$/m)
    expect(merged.output).toContain('corrected: depends — #77 → (removed) — already merged')
  })

  it('applies the same rule to blocks', () => {
    const open = parkedCardText(journalOf(DONE), { blocks: ['#77'] })
    expect(open.text).toMatch(/^card: #14 \S+ \[.*\] · depends — · blocks #77$/m)
    expect(open.output).not.toContain('corrected: blocks')
    const merged = parkedCardText(journalOf(DONE, MERGED), { blocks: ['#77'] })
    expect(merged.output).toContain('corrected: blocks — #77 → (removed) — already merged')
    expect(merged.text).toMatch(/^card: #14 \S+ \[.*\] · depends — · blocks —$/m)
  })
})
