import type { IntakeResult } from '../src/commands/intake/index.js'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { printIntake, runIntake } from '../src/commands/intake/index.js'
import { createUi } from '../src/ui/console.js'
import { resolveTheme } from '../src/ui/theme.js'

const TASK = 'The intake should read a depends as met only once its pull request is merged.'
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

function parkedCardText(cards: ReadonlyMap<string, string>, fields: Record<string, unknown>): { text: string, output: string } {
  const root = scratch()
  const parking = path.join(root, 'parking')
  mkdirSync(parking)
  writeFileSync(path.join(parking, '13.md'), '')
  const draft = path.join(root, 'draft.json')
  const card = { name: 'merge-card', kind: 'implement', milestone: 'runner', size: 'S', contour: 'cheap', decision: 'owner', touches: ['src/a.ts'], task: TASK, witnesses: ['`pnpm run quality` is green'], ...fields }
  writeFileSync(draft, JSON.stringify({ cards: [card] }))
  const result: IntakeResult = runIntake({ draft, parking, dir: root, dryRun: false, autoConfirm: true, readStdin: () => '12', taken: '-', cardStates: () => cards })
  if (result.status === 'refused')
    throw new Error(`refused: ${result.refusal} ${result.detail.join('; ')}`)
  const lines: string[] = []
  printIntake(createUi(resolveTheme({ plain: true }), line => lines.push(line)), result)
  const assigned = result.status === 'written' ? result.cards[0]!.id : 14
  return { text: readFileSync(path.join(parking, `${assigned}.md`), 'utf8'), output: lines.join('\n') }
}

describe('a depends or blocks is met by a card the bus holds merged or closed, not by one still in work', () => {
  it('keeps a depends on a card the bus holds in work and removes it once the bus holds it merged', () => {
    const open = parkedCardText(new Map([['77', 'running']]), { depends: ['#77'] })
    expect(open.text).toMatch(/^card: #78 \S+ \[.*\] · depends #77 · blocks —$/m)
    expect(open.output).not.toContain('corrected: depends')
    const merged = parkedCardText(new Map([['77', 'merged']]), { depends: ['#77'] })
    expect(merged.text).toMatch(/^card: #78 \S+ \[.*\] · depends — · blocks —$/m)
    expect(merged.output).toContain('corrected: depends — #77 → (removed) — already merged')
  })

  it('applies the same rule to blocks', () => {
    const open = parkedCardText(new Map([['77', 'running']]), { blocks: ['#77'] })
    expect(open.text).toMatch(/^card: #78 \S+ \[.*\] · depends — · blocks #77$/m)
    expect(open.output).not.toContain('corrected: blocks')
    const merged = parkedCardText(new Map([['77', 'merged']]), { blocks: ['#77'] })
    expect(merged.output).toContain('corrected: blocks — #77 → (removed) — already merged')
    expect(merged.text).toMatch(/^card: #78 \S+ \[.*\] · depends — · blocks —$/m)
  })

  it('reads a depends as merged when the bus holds its card closed', () => {
    const byBus = parkedCardText(new Map([['77', 'closed']]), { depends: ['#77'] })
    expect(byBus.output).toContain('corrected: depends — #77 → (removed) — already merged')
  })
})
