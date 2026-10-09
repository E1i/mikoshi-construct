import type { IntakeResult } from '../src/commands/intake/index.js'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { splitSignal } from '../src/card/complexity.js'
import { WINDOW_WHO } from '../src/card/parking.js'
import { RISK_LEVELS, RISK_MEANING, RISK_PREFIX, riskOf, riskReading, SEAM_PREFIX, SLICE_PREFIX } from '../src/card/risk.js'
import { printIntake, runIntake } from '../src/commands/intake/index.js'
import { createUi } from '../src/ui/console.js'
import { resolveTheme } from '../src/ui/theme.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')

const LEVEL_OF_PATH: Record<string, string> = {
  'templates/attach/earlier-carriers.json': 'R1',
  'templates/ai/claude/_claude/skills/intake/SKILL.md': 'R1',
  'scripts/construct/check-acceptance.mjs': 'R1',
  '.claude/agents/harness.md': 'R1',
  '.claude/skills/implement/SKILL.md': 'R1',
  'architecture/security-invariants.md': 'R1',
  'src/commands/sync/**': 'R1',
  'src/commands/**': 'R1',
  'contract/surface.json': 'R2',
  'src/detect/layout.ts': 'R2',
  'src/commands/intake/slice.ts': 'R3',
  'scripts/composition/check.ts': 'R3',
  'docs/cli.md': 'R4',
  'architecture/intake.md': 'R4',
  'tests/**': 'R4',
  'scripts/shredder/classify.ts': 'R4',
  'scripts/ghosts': 'R2',
  'scripts/ghosts/verdict.ts': 'R2',
  'scripts/ghosts/task-close.ts': 'R2',
  'scripts/shift': 'R2',
  'scripts/shift/merge.ts': 'R2',
  'scripts/ghosts/approval.ts': 'R1',
  'scripts/ghosts/hash.ts': 'R1',
  'scripts/ghosts/launch.ts': 'R1',
  'scripts/ghosts/**': 'R1',
  'src/presets/index.ts': 'R1',
  'scripts/attach/earlier-carriers.ts': 'R1',
  'src/model/schema.ts': 'R2',
  'README.md': 'R4',
}

const ALWAYS_HIGH_OR_PUBLISH = [
  '.changeset/config.json',
  'scripts/release/verify-published.ts',
  '.github/workflows/release.yml',
  'architecture/composition/init.yaml',
  'eslint.config.mjs',
  'architecture/owner-merges.md',
]

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function draftCard(name: string, touches: readonly string[], unclear: number) {
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

function intake(touches: readonly string[], unclear: number = 0, confirm?: string, root: string = mkdtempSync(path.join(tmpdir(), 'intake-risk-'))): IntakeResult {
  roots.push(root)
  const repo = path.join(root, 'repo')
  for (const entry of touches) {
    const target = path.join(repo, entry.replace(/\/\*\*$/, ''))
    mkdirSync(entry.endsWith('/**') ? target : path.dirname(target), { recursive: true })
    if (!entry.endsWith('/**'))
      writeFileSync(target, '')
  }
  const draft = path.join(root, 'draft.json')
  writeFileSync(draft, JSON.stringify({ cards: [draftCard('risk-card', touches, unclear)] }))
  return runIntake({ draft, taken: '-', parking: path.join(root, 'parking'), dir: repo, journal: path.join(root, 'ghosts.jsonl'), dryRun: false, autoConfirm: false, confirm, readStdin: () => '600' })
}

function only(result: IntakeResult) {
  if (result.status === 'refused')
    throw new Error(`refused: ${result.detail.join('; ')}`)
  return result.cards[0]!
}

function linesOf(text: string, prefix: string): string[] {
  return text.split('\n').filter(line => line.startsWith(prefix))
}

describe('each path has the level its kind of change carries', () => {
  for (const [touch, level] of Object.entries(LEVEL_OF_PATH)) {
    it(`${touch} is ${level}`, () => {
      expect(riskOf(touch).level).toBe(level)
    })
  }
})

describe('a path AGENTS.md names always high or a publish reads R1, never R3 or R4', () => {
  it.each(ALWAYS_HIGH_OR_PUBLISH)('always high: %s is R1', (touch) => {
    expect(riskOf(touch).level).toBe('R1')
  })
})

describe('intake writes the risk line into the card', () => {
  it('r4 for docs and tests only', () => {
    const card = only(intake(['docs/cli.md', 'architecture/intake.md', 'tests/intake-risk.test.ts', '.changeset/risk.md', 'README.md']))
    const [risk] = linesOf(card.text, RISK_PREFIX)
    expect(risk).toMatch(/^risk: R4 — /)
    expect(linesOf(card.text, SEAM_PREFIX)).toEqual([])
    expect(card.who).toBe('shift')
  })

  it('r1 for an attach carrier', () => {
    const card = only(intake(['templates/attach/earlier-carriers.json', 'tests/attach-carriers.test.ts']))
    const [risk] = linesOf(card.text, RISK_PREFIX)
    expect(risk).toMatch(/^risk: R1 — /)
    expect(risk).toContain('write into another repository: templates/attach/earlier-carriers.json')
    expect(linesOf(card.text, SLICE_PREFIX)).toEqual([])
  })

  it('the highest level decides and every touch at it is named', () => {
    const reading = riskReading(['docs/cli.md', 'contract/surface.json', 'src/detect/layout.ts'], false)
    expect(reading.level).toBe('R2')
    expect(reading.why).toContain('contract/surface.json, src/detect/layout.ts')
    expect(reading.slices).toEqual([])
  })
})

describe('a card that mixes R1 with R3–R4 is offered a risk seam', () => {
  it('slices by the risk seam when the complexity seam proposed no slices', () => {
    const touches = ['architecture/security-invariants.md', 'src/commands/intake/slice.ts', 'docs/cli.md', 'tests/intake-risk.test.ts']
    const result = intake(touches)
    const card = only(result)
    expect(card.who).toBe(WINDOW_WHO)
    expect(card.line).toContain('[implement/black-ice/S/cheap/owner]')
    const seam = linesOf(card.text, SEAM_PREFIX)
    expect(seam).toHaveLength(1)
    expect(seam[0]).toMatch(/^seam: risk — /)
    expect(seam[0]).toContain('a person confirms the slices or keeps the card whole')
    expect(linesOf(card.text, SLICE_PREFIX)).toEqual([
      'slice: 1 R1 — architecture/security-invariants.md',
      'slice: 2 R3 — src/commands/intake/slice.ts, docs/cli.md, tests/intake-risk.test.ts',
    ])
    const out: string[] = []
    printIntake(createUi(resolveTheme({ plain: true }), text => out.push(text)), result)
    expect(out.join('')).toContain(seam[0])
  })

  it('keeps a generated file with its sources and a template with its twin', () => {
    const reading = riskReading(['scripts/attach/earlier-carriers.ts', 'scripts/construct/browser-witness.mjs', 'templates/ai/claude/scripts/construct/browser-witness.mjs', 'templates/attach/earlier-carriers.json', 'scripts/shredder/classify.ts'], false)
    expect(reading.slices.map(slice => [slice.level, slice.touches])).toEqual([
      ['R1', ['scripts/attach/earlier-carriers.ts', 'scripts/construct/browser-witness.mjs', 'templates/ai/claude/scripts/construct/browser-witness.mjs', 'templates/attach/earlier-carriers.json']],
      ['R4', ['scripts/shredder/classify.ts']],
    ])
  })

  it('names the capability / delivery seam: the script and its tests apart from the carrier registration', () => {
    const card = only(intake(['scripts/shredder/classify.ts', 'tests/shredder.test.ts', 'src/presets/index.ts', 'templates/ai/claude/_claude/skills/intake/SKILL.md', '.claude/skills/intake/SKILL.md']))
    expect(linesOf(card.text, SEAM_PREFIX)[0]).toMatch(/^seam: risk \(capability \/ delivery\) — /)
    expect(linesOf(card.text, SLICE_PREFIX)).toEqual([
      'slice: 1 R1 delivery — src/presets/index.ts, templates/ai/claude/_claude/skills/intake/SKILL.md, .claude/skills/intake/SKILL.md',
      'slice: 2 R4 capability — scripts/shredder/classify.ts, tests/shredder.test.ts',
    ])
  })

  it('keeps a test with the R1 code it witnesses and leaves an unnamed test with the rest', () => {
    const reading = riskReading(['src/commands/sync/index.ts', 'tests/sync.test.ts', 'tests/docs.test.ts', 'docs/cli.md', 'scripts/shredder/classify.ts'], false)
    expect(reading.slices.map(slice => slice.touches)).toEqual([
      ['src/commands/sync/index.ts', 'tests/sync.test.ts'],
      ['tests/docs.test.ts', 'docs/cli.md', 'scripts/shredder/classify.ts'],
    ])
  })

  it('keeps the capability / delivery seam when a test rides with the delivery slice', () => {
    const reading = riskReading(['src/presets/index.ts', 'tests/presets.test.ts', 'scripts/shredder/classify.ts', 'tests/shredder.test.ts'], false)
    expect(reading.capabilityDelivery).toBe(true)
    expect(reading.slices.map(slice => slice.touches)).toEqual([
      ['src/presets/index.ts', 'tests/presets.test.ts'],
      ['scripts/shredder/classify.ts', 'tests/shredder.test.ts'],
    ])
  })

  it('a test under scripts/tests rides with the R1 script it witnesses', () => {
    const reading = riskReading(['scripts/attach/earlier-carriers.ts', 'scripts/tests/attach/earlier-carriers.test.ts', 'docs/cli.md'], false)
    expect(reading.slices.map(slice => [slice.level, slice.touches])).toEqual([
      ['R1', ['scripts/attach/earlier-carriers.ts', 'scripts/tests/attach/earlier-carriers.test.ts']],
      ['R4', ['docs/cli.md']],
    ])
  })

  it('a test whose directory names the code rides with it', () => {
    const reading = riskReading(['src/commands/detach/**', 'tests/detach/restore.test.ts', 'docs/cli.md'], false)
    expect(reading.slices.map(slice => slice.touches)).toEqual([
      ['src/commands/detach/**', 'tests/detach/restore.test.ts'],
      ['docs/cli.md'],
    ])
  })

  it('a top-level root never makes a test a witness', () => {
    const reading = riskReading(['architecture/composition/init.yaml', 'tests/architecture-links.test.ts', 'src/commands/attach/index.ts', 'tests/commands.test.ts', 'docs/cli.md'], false)
    expect(reading.slices.map(slice => slice.touches)).toEqual([
      ['architecture/composition/init.yaml', 'src/commands/attach/index.ts'],
      ['tests/architecture-links.test.ts', 'tests/commands.test.ts', 'docs/cli.md'],
    ])
  })

  it('a test named for the code with a suffix rides with it', () => {
    const reading = riskReading(['src/commands/detach/**', 'tests/detach-restore.test.ts', 'docs/cli.md'], false)
    expect(reading.slices.map(slice => slice.touches)).toEqual([
      ['src/commands/detach/**', 'tests/detach-restore.test.ts'],
      ['docs/cli.md'],
    ])
  })

  it('offers nothing when the only lower touches are tests and the changeset that go with the change', () => {
    expect(riskReading(['templates/base/architecture/principles.md', 'tests/presets.test.ts', '.changeset/x.md'], false).slices).toEqual([])
  })

  it('offers the risk seam when complexity slices still mix R1 and R4', () => {
    const touches = ['scripts/construct/implement.workflow', 'scripts/shredder/classify.ts', 'docs/shredder.md']
    expect(splitSignal({ touches, unclear: 3 })).toMatchObject({ split: true, slices: [], mixed: true })
    const card = only(intake(touches, 3))
    expect(linesOf(card.text, SEAM_PREFIX).map(line => line.split(' — ')[0])).toEqual(['seam: complexity', 'seam: risk'])
    expect(linesOf(card.text, SLICE_PREFIX)).toEqual([
      'slice: 1 R1 — scripts/construct/implement.workflow',
      'slice: 2 R4 — scripts/shredder/classify.ts, docs/shredder.md',
    ])
  })

  it('leaves slicing to the complexity seam when it proposed slices', () => {
    const touches = [...Array.from({ length: 4 }, (_, index) => `templates/base/part-${index}.md`), 'docs/a.md', 'docs/b.md', 'docs/c.md']
    const card = only(intake(touches, 3))
    expect(linesOf(card.text, SEAM_PREFIX).map(line => line.split(' — ')[0])).toEqual(['seam: complexity'])
    expect(riskReading(touches, true).slices).toEqual([])
    expect(riskReading(touches, false).slices).toHaveLength(2)
  })
})

describe('a proposed risk seam waits for the confirmation token corrections wait for', () => {
  const touches = ['architecture/security-invariants.md', 'src/commands/intake/slice.ts', 'docs/cli.md']

  it('parks nothing until a person confirms the token, then journals the confirmation as a person\'s', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'intake-risk-'))
    const held = intake(touches, 0, undefined, root)
    expect(existsSync(path.join(root, 'parking'))).toBe(false)
    expect(existsSync(path.join(root, 'ghosts.jsonl'))).toBe(false)
    expect(held.status).toBe('awaiting')
    const token = held.status === 'awaiting' ? held.token : ''
    const out: string[] = []
    printIntake(createUi(resolveTheme({ plain: true }), text => out.push(text)), held)
    expect(out.at(-1)).toContain(`--confirm ${token}`)
    expect(intake(touches, 0, token, root).status).toBe('written')
    expect(JSON.parse(readFileSync(path.join(root, 'ghosts.jsonl'), 'utf8'))).toMatchObject({ event: 'intake', confirmation: 'person', corrections: [] })
  })

  it('a card with no risk seam is written without a token', () => {
    expect(intake(['templates/attach/earlier-carriers.json', 'tests/attach-carriers.test.ts']).status).toBe('written')
  })
})

describe('the risk levels are one list, two readers', () => {
  const doc = readFileSync(path.join(REPO_ROOT, 'architecture/intake.md'), 'utf8')
  for (const level of RISK_LEVELS) {
    it(`architecture/intake.md explains ${level}`, () => {
      expect(doc).toContain(`\`${level}\` — ${RISK_MEANING[level]}`)
    })
  }
})
