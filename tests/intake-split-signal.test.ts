import type { ShiftDeps } from '../scripts/shift/shift.js'
import type { SignalName } from '../src/card/complexity.js'
import type { IntakeOptions, IntakeResult } from '../src/commands/intake/index.js'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { relation } from '../scripts/shift/overlap.js'
import { runShift } from '../scripts/shift/shift.js'
import { splitSignal } from '../src/card/complexity.js'
import { WINDOW_WHO } from '../src/card/parking.js'
import { SEAM_PREFIX, SLICE_PREFIX } from '../src/card/risk.js'
import { printIntake, runIntake } from '../src/commands/intake/index.js'
import { createUi } from '../src/ui/console.js'
import { resolveTheme } from '../src/ui/theme.js'

const WITNESS_CARDS: Record<string, { touches: string[], split: boolean, signals: SignalName[] }> = {
  '#55 red-base-gate': {
    touches: [
      'scripts/construct/implement.workflow',
      'templates/ai/claude/scripts/construct/implement.workflow',
      'scripts/construct/check-acceptance.mjs',
      'templates/ai/claude/scripts/construct/check-acceptance.mjs',
      '.claude/agents/harness.md',
      'templates/ai/claude/_claude/agents/harness.md',
      '.claude/skills/implement/SKILL.md',
      'templates/ai/claude/_claude/skills/implement/SKILL.md',
      'templates/attach/earlier-carriers.json',
      'architecture/decisions/0050-a-base-red-in-a-way-that-cannot-be-identified-runs-nothing.md',
      'architecture/decisions/README.md',
      'README.md',
      'docs/guide/reasoning-budget.md',
      'tests/ladder-red-base.test.ts',
      'tests/check-acceptance-build.test.ts',
      '.changeset/**',
    ],
    split: true,
    signals: ['touches', 'self', 'generated'],
  },
  '#543 intake-fact-check': {
    touches: [
      'src/commands/**',
      'src/model/**',
      'src/card/grammar.ts',
      'src/card/closed.ts',
      'scripts/shift/places.ts',
      'scripts/shift/shift.ts',
      'scripts/shift/report.ts',
      'src/program.ts',
      'src/ui/lore.ts',
      'tests/**',
      'architecture/composition/intake.yaml',
      'architecture/intake.md',
      'docs/cli.md',
      'contract/surface.json',
      '.changeset/**',
    ],
    split: true,
    signals: ['touches', 'self', 'generated'],
  },
  '#531 engram-schema': {
    touches: ['src/model/**', 'src/detect/**', 'architecture/engram.md', 'tests/**'],
    split: false,
    signals: [],
  },
  '#530 atlas-lore-rule': {
    touches: ['AGENTS.md'],
    split: false,
    signals: [],
  },
}

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function scratch(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'intake-split-'))
  roots.push(root)
  return root
}

function draftCard(name: string, touches: readonly string[], unclear: number = 0) {
  return {
    name,
    kind: 'implement',
    milestone: 'black-ice',
    size: 'S',
    contour: 'cheap',
    decision: 'owner',
    who: 'shift',
    touches,
    task: `The change ${name} describes.`,
    witnesses: ['`pnpm test` passes'],
    unclear: Array.from({ length: unclear }, (_, index) => ({ field: `field-${index}`, reason: 'not stated' })),
  }
}

function repositoryOf(root: string, cards: unknown): string {
  const repo = path.join(root, 'repo')
  mkdirSync(repo, { recursive: true })
  const touches = Array.isArray(cards) ? cards.flatMap(card => (card as { touches?: string[] }).touches ?? []) : []
  for (const entry of touches) {
    const target = path.join(repo, entry.replace(/\/\*\*$/, ''))
    mkdirSync(entry.endsWith('/**') ? target : path.dirname(target), { recursive: true })
    if (!entry.endsWith('/**'))
      writeFileSync(target, '')
  }
  return repo
}

function intake(root: string, cards: unknown[], options: Partial<IntakeOptions> = {}): IntakeResult {
  const draft = path.join(root, 'draft.json')
  writeFileSync(draft, JSON.stringify({ cards }))
  return runIntake({ draft, taken: '-', parking: path.join(root, 'parking'), dir: repositoryOf(root, cards), journal: path.join(root, 'ghosts.jsonl'), dryRun: false, autoConfirm: false, readStdin: () => '600', ...options })
}

function sliced(result: IntakeResult) {
  if (result.status === 'refused')
    throw new Error(`refused: ${result.detail.join('; ')}`)
  return result.cards
}

function shiftDeps(root: string, out: string[], err: string[]): ShiftDeps {
  const unused = (): never => {
    throw new Error('a --check run starts nothing')
  }
  return {
    cwd: root,
    claude: undefined,
    header: '',
    handoffDir: path.join(root, 'handoff'),
    readJournal: unused,
    projectsDir: path.join(root, 'projects'),
    git: unused,
    install: unused,
    gh: () => {
      throw new Error('gh is not read in this test')
    },
    listDir: dir => readdirSync(dir),
    read: file => readFileSync(file, 'utf8'),
    exists: existsSync,
    append: unused,
    now: () => new Date('2026-10-05T00:00:00.000Z'),
    uuid: () => 'uuid',
    run: unused,
    out: line => out.push(line),
    err: line => err.push(line),
  }
}

describe('the split signal reads the 04–05.10 cards as the owner did', () => {
  for (const [card, expected] of Object.entries(WITNESS_CARDS)) {
    it(`${card}: ${expected.split ? 'slice before work' : 'take whole'}, signals ${expected.signals.join(', ') || 'none'}`, () => {
      const verdict = splitSignal({ touches: expected.touches, unclear: 0 })
      expect(verdict.signals.map(signal => signal.name)).toEqual(expected.signals)
      expect(verdict.split).toBe(expected.split)
    })
  }

  it('one signal alone does not split: eight touches in one area', () => {
    const touches = Array.from({ length: 8 }, (_, index) => `src/model/part-${index}.ts`)
    const verdict = splitSignal({ touches, unclear: 0 })
    expect(verdict.signals.map(signal => signal.name)).toEqual(['touches'])
    expect(verdict.split).toBe(false)
  })

  it('more than two unclear fields is a signal of its own', () => {
    expect(splitSignal({ touches: ['scripts/ghosts/launch.ts'], unclear: 3 }).split).toBe(true)
    expect(splitSignal({ touches: ['scripts/ghosts/launch.ts'], unclear: 2 }).split).toBe(false)
  })

  it('a glob over the mechanism the task runs on reaches it', () => {
    expect(splitSignal({ touches: ['scripts/**'], unclear: 0 }).signals.map(signal => signal.name)).toEqual(['self'])
  })
})

describe('intake writes the slicing principle into a card the signal splits', () => {
  it('holds the card for the window and names every signal that fired, in the card and in the output', () => {
    const root = scratch()
    const [card] = sliced(intake(root, [draftCard('red-base-gate', WITNESS_CARDS['#55 red-base-gate']!.touches)]))
    expect(card!.who).toBe(WINDOW_WHO)
    const seam = card!.text.split('\n').filter(line => line.startsWith(SEAM_PREFIX))
    expect(seam).toHaveLength(1)
    expect(seam[0]).toContain('16 touches over 5 areas')
    expect(seam[0]).toContain('touches the mechanism the task runs on: scripts/construct/implement.workflow')
    expect(seam[0]).toContain('generated templates/attach/earlier-carriers.json with its sources')
    expect(seam[0]).toContain('by the risk matrix R1–R4')
    const out: string[] = []
    printIntake(createUi(resolveTheme({ plain: true }), text => out.push(text)), intake(scratch(), [draftCard('red-base-gate', WITNESS_CARDS['#55 red-base-gate']!.touches)]))
    expect(out.join('')).toContain(seam[0])
  })

  it('leaves a card the signal does not split as the draft states it', () => {
    const root = scratch()
    const [card] = sliced(intake(root, [draftCard('engram-schema', WITNESS_CARDS['#531 engram-schema']!.touches)]))
    expect(card!.who).toBe('shift')
    expect(card!.seam).toEqual([])
    expect(card!.text).not.toContain(SEAM_PREFIX)
  })

  for (const name of ['#55 red-base-gate']) {
    it(`${name}: the proposed slices take disjoint touches and pass shift --check as cards`, async () => {
      const verdict = splitSignal({ touches: WITNESS_CARDS[name]!.touches, unclear: 0 })
      expect(verdict.slices.length).toBeGreaterThan(1)
      expect(verdict.slices.flatMap(slice => slice.touches).sort()).toEqual([...WITNESS_CARDS[name]!.touches].sort())
      const entries = verdict.slices.flatMap((slice, index) => slice.touches.map(entry => ({ index, entry })))
      const crossing = entries.flatMap(a => entries.filter(b => b.index > a.index && relation(a.entry, b.entry) !== null).map(b => `${a.entry} × ${b.entry}`))
      expect(crossing).toEqual([])
      const root = scratch()
      const written = sliced(intake(root, verdict.slices.map(slice => draftCard(`slice-${slice.area}`, slice.touches))))
      const out: string[] = []
      const err: string[] = []
      const exit = await runShift([path.join(root, 'shift'), '--parking', path.join(root, 'parking'), '--check'], shiftDeps(root, out, err))
      expect(err.filter(line => !line.includes('open pull requests not read'))).toEqual([])
      expect(exit).toBe(0)
      const taken = written.filter(card => card.who === 'shift').map(card => card.file)
      expect(taken.length).toBeGreaterThan(0)
      expect(out.join('\n')).toContain(`check passed: ${taken.join(', ')}`)
    })
  }

  it('keeps a generated file with its sources and a template with its twin in one slice', () => {
    const touches = ['contract/surface.json', 'src/program.ts', 'scripts/contract/surface.ts', 'templates/ai/claude/_claude/skills/intake/SKILL.md', '.claude/skills/intake/SKILL.md', 'templates/attach/earlier-carriers.json', 'docs/cli.md', 'tests/intake.test.ts']
    const [card] = sliced(intake(scratch(), [draftCard('generated-with-sources', touches)]))
    expect(card!.text.split('\n').filter(line => line.startsWith(SLICE_PREFIX))).toEqual([
      'slice: 1 mechanism — contract/surface.json, src/program.ts, scripts/contract/surface.ts, tests/intake.test.ts',
      'slice: 2 prompts — templates/ai/claude/_claude/skills/intake/SKILL.md, .claude/skills/intake/SKILL.md, templates/attach/earlier-carriers.json',
      'slice: 3 documents — docs/cli.md',
    ])
  })

  it('#543 intake-fact-check: proposes no complexity slices when they would still mix R1 with R3–R4, and names why', () => {
    const verdict = splitSignal({ touches: WITNESS_CARDS['#543 intake-fact-check']!.touches, unclear: 0 })
    expect(verdict.split).toBe(true)
    expect(verdict.slices).toEqual([])
    expect(verdict.mixed).toBe(true)
    const [card] = sliced(intake(scratch(), [draftCard('intake-fact-check', WITNESS_CARDS['#543 intake-fact-check']!.touches)]))
    const seams = card!.text.split('\n').filter(line => line.startsWith(SEAM_PREFIX))
    expect(seams.map(line => line.split(' — ')[0])).toEqual(['seam: complexity', 'seam: risk'])
    expect(seams[0]).toContain('would still hold R1 together with R3–R4 work')
  })
})
