import type { DoctorResult, MarkerReading } from '../src/commands/doctor/index.js'
import type { StoppingState } from '../src/model/path.js'
import type { ThemeName } from '../src/ui/theme.js'
import { describe, expect, it } from 'vitest'
import { printDoctor } from '../src/commands/doctor/index.js'
import { CHAIN_STAGES } from '../src/model/path.js'
import { MODEL_STATES } from '../src/model/state.js'
import { createUi } from '../src/ui/console.js'
import { resolveTheme } from '../src/ui/theme.js'

const YOU_ARE_HERE_LINE = /^[ \t]*(?:YOU ARE HERE|You are here): \S/
const STOPPING_STATES = MODEL_STATES.filter((state): state is StoppingState => state !== 'held')
const VERDICT_WORDING = /\b(?:not enforced|unenforced|proven|proves|fail|broken|violat)/i
const EMOJI = /[\u2600-\u27BF\u2B00-\u2BFF\u{1F000}-\u{1FAFF}]/u
const LORE_VOCABULARY = ['GLITCH', 'FLATLINED', 'CONSTRUCT STABLE', 'SOULKILLER', 'Netrunner', 'ARASAKA', 'ENFORCEMENT TRACE', 'YOU ARE HERE', 'NOTHING HERE IS EXECUTED']

function result(overrides: Partial<DoctorResult> = {}): DoctorResult {
  return {
    ok: true,
    missingFiles: [],
    modifiedFiles: [],
    missingDiscovery: [],
    provenance: [],
    harnessProblems: [],
    uncollectedTests: [],
    warnings: [],
    checks: [
      { id: 'lint-policy', claimId: 'lint-policy', level: 'L3', state: 'held', authoredBy: 'construct', evidence: 'scripts/tests/lint/syntax-policy.test.ts asserts the restrictions the lint policy declares' },
      { id: 'ci', claimId: 'every-change-passes-the-harness', level: 'L3', state: 'held', authoredBy: 'construct', evidence: '.github/workflows/ci.yml runs pnpm run quality on every pull request and push to main' },
    ],
    youAreHere: { claimId: 'lint-policy', stage: 'verification', state: 'unsupported' },
    versionGap: { materializedBy: '0.1.0', readBy: '0.2.0', pending: 0 },
    ...overrides,
  }
}

function render(value: DoctorResult | null, theme: ThemeName = 'plain'): { output: string, code: number } {
  const lines: string[] = []
  const ui = createUi(resolveTheme({ plain: theme === 'plain', johnny: theme === 'johnny' }), text => lines.push(text))
  const code = printDoctor(ui, value)
  // eslint-disable-next-line no-control-regex
  return { output: lines.join('').replaceAll(/\[[\d;]*m/g, ''), code }
}

function nonEmptyLines(output: string): string[] {
  return output.split('\n').filter(line => line.trim() !== '')
}

describe('the doctor report', () => {
  for (const theme of ['plain', 'arasaka', 'johnny'] as const) {
    it(`ends with exactly one you-are-here line in the ${theme} theme`, () => {
      const { output } = render(result(), theme)
      expect(nonEmptyLines(output).at(-1)).toMatch(YOU_ARE_HERE_LINE)
      expect(nonEmptyLines(output).filter(line => YOU_ARE_HERE_LINE.test(line))).toHaveLength(1)
    })
  }

  it('names the claim and the stage where the chain stops, taking both from the model', () => {
    const line = nonEmptyLines(render(result()).output).at(-1) ?? ''
    expect(line).toContain('lint-policy')
    expect(line).toContain('verification')
    expect(line).toContain('unsupported')
  })

  it('reads a stopped chain as a state and never as a verdict, in every stage and state it can report', () => {
    for (const stage of CHAIN_STAGES) {
      for (const state of STOPPING_STATES) {
        for (const theme of ['plain', 'arasaka', 'johnny'] as const) {
          const line = nonEmptyLines(render(result({ youAreHere: { claimId: 'lint-policy', stage, state } }), theme).output).at(-1) ?? ''
          expect(line).toMatch(YOU_ARE_HERE_LINE)
          expect(line).toContain(stage)
          expect(line).toContain(state)
          expect(line).not.toMatch(VERDICT_WORDING)
        }
      }
    }
  })

  it('names every check and says when no chain stops', () => {
    const { output } = render(result({ youAreHere: null }))
    for (const check of result().checks)
      expect(output).toContain(check.id)
    expect(nonEmptyLines(output).at(-1)).toContain('no claim stops before the end of its chain')
    expect(nonEmptyLines(output).filter(line => YOU_ARE_HERE_LINE.test(line))).toHaveLength(1)
  })

  it('states the boundary it reports from, since it runs nothing it could prove the harness with', () => {
    const { output } = render(result())
    expect(output).toContain('doctor executes nothing from the repository it inspects')
    expect(output).toContain('does not speak about whether the harness passes')
  })

  it('names the recorded tests the runner never collects, without changing the exit code', () => {
    const { output, code } = render(result({ uncollectedTests: ['tests/harness.test.ts'] }))
    expect(output).toContain('tests/harness.test.ts')
    expect(code).toBe(0)
  })

  it('names the markers still reading back what discovery wrote, above the you-are-here line and without changing the exit code', () => {
    const provenance: MarkerReading[] = [
      { marker: 'product', file: 'AGENTS.md', authorship: 'construct' },
      { marker: 'module-map', file: 'AGENTS.md', authorship: 'owner' },
      { marker: 'composition', file: 'architecture/composition', authorship: 'unknown' },
    ]
    const { output, code } = render(result({ provenance }))
    expect(output).toContain('product')
    expect(output).not.toContain('module-map')
    expect(output).not.toContain('architecture/composition')
    expect(nonEmptyLines(output).at(-1)).toMatch(YOU_ARE_HERE_LINE)
    expect(code).toBe(0)
  })

  it('says nothing about provenance when no marker still reads as the construct\'s own', () => {
    const provenance: MarkerReading[] = [{ marker: 'product', file: 'AGENTS.md', authorship: 'owner' }]
    expect(render(result({ provenance })).output).not.toContain('Discovery provenance')
  })

  it('names the version gap and the paths a sync would write, above the you-are-here line and without changing the exit code', () => {
    const { output, code } = render(result({ versionGap: { materializedBy: '0.1.0', readBy: '0.2.0', pending: 3 } }))
    expect(output).toContain('Materialized by construct 0.1.0, read by 0.2.0.')
    expect(output).toContain('3 recorded paths a sync would add or update')
    expect(nonEmptyLines(output).at(-1)).toMatch(YOU_ARE_HERE_LINE)
    expect(code).toBe(0)
  })

  it('says the gap cannot be established rather than counting nothing when the replay could not run', () => {
    const { output, code } = render(result({ versionGap: { materializedBy: '0.1.0', readBy: '0.2.0', pending: null } }))
    expect(output).toContain('cannot be established')
    expect(code).toBe(0)
  })

  it('carries no emoji and no lore vocabulary with --plain', () => {
    const { output } = render(result({
      missingFiles: ['AGENTS.md'],
      missingDiscovery: ['product'],
      uncollectedTests: ['tests/harness.test.ts'],
      provenance: [{ marker: 'product', file: 'AGENTS.md', authorship: 'construct' }],
      modifiedFiles: ['CLAUDE.md'],
      warnings: ['node-frontend: `tsc --noEmit` does not see `.vue` components'],
      versionGap: { materializedBy: '0.1.0', readBy: '0.2.0', pending: 2 },
      ok: false,
    }))
    expect(output).not.toMatch(EMOJI)
    for (const word of LORE_VOCABULARY)
      expect(output).not.toContain(word)
  })

  it('exits 1 only for a missing baseline file, a broken harness or a missing construct.json', () => {
    expect(render(result()).code).toBe(0)
    expect(render(result({ youAreHere: { claimId: 'lint-policy', stage: 'enforcement', state: 'unsupported' } })).code).toBe(0)
    expect(render(result({ missingDiscovery: ['product'], modifiedFiles: ['CLAUDE.md'] })).code).toBe(0)
    expect(render(result({ ok: false, missingFiles: ['AGENTS.md'] })).code).toBe(1)
    expect(render(result({ ok: false, harnessProblems: ['"quality" does not run test'] })).code).toBe(1)
    expect(render(null).code).toBe(1)
  })
})
