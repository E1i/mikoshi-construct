import type { DoctorResult, MarkerReading } from '../src/commands/doctor/index.js'
import type { ThemeName } from '../src/ui/theme.js'
import { describe, expect, it } from 'vitest'
import { printDoctor } from '../src/commands/doctor/index.js'
import { createUi } from '../src/ui/console.js'
import { resolveTheme } from '../src/ui/theme.js'

const WEAKEST_LINK_LINE = /^[ \t]*(?:WEAKEST LINK|Weakest link): \S/
const EMOJI = /[\u2600-\u27BF\u2B00-\u2BFF\u{1F000}-\u{1FAFF}]/u
const LORE_VOCABULARY = ['GLITCH', 'FLATLINED', 'CONSTRUCT STABLE', 'SOULKILLER', 'Netrunner', 'ARASAKA', 'ENFORCEMENT TRACE', 'WEAKEST LINK']

function result(overrides: Partial<DoctorResult> = {}): DoctorResult {
  return {
    ok: true,
    missingFiles: [],
    modifiedFiles: [],
    missingDiscovery: [],
    provenance: [],
    harnessProblems: [],
    warnings: [],
    checks: [
      { id: 'lint-policy', level: 'L3', state: 'present', evidence: 'scripts/tests/lint/syntax-policy.test.ts resolves the lint policy' },
      { id: 'construct-tests', level: 'L3', state: 'present', evidence: 'every recorded test matches the include in vitest.config.ts' },
      { id: 'ci', level: 'L3', state: 'present', evidence: '.github/workflows/ci.yml runs "pnpm run quality"' },
      { id: 'hook', level: 'L2', state: 'present', evidence: 'lefthook.yml installs a git hook' },
      { id: 'red-gate', level: 'L3', state: 'unknown', evidence: 'doctor executes nothing from the repository it inspects' },
    ],
    weakestLink: { id: 'hook', level: 'L2' },
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
    it(`ends with exactly one weakest-link line in the ${theme} theme`, () => {
      const { output } = render(result(), theme)
      expect(nonEmptyLines(output).at(-1)).toMatch(WEAKEST_LINK_LINE)
      expect(nonEmptyLines(output).filter(line => WEAKEST_LINK_LINE.test(line))).toHaveLength(1)
    })
  }

  it('names what would raise the weakest link, so a low reading reads as a state and not a verdict', () => {
    for (const level of ['L0', 'L1', 'L2', 'L3'] as const) {
      const line = nonEmptyLines(render(result({ weakestLink: { id: 'hook', level } })).output).at(-1) ?? ''
      expect(line).toMatch(WEAKEST_LINK_LINE)
      expect(line.length).toBeGreaterThan(`Weakest link: hook at ${level}`.length)
    }
  })

  it('names every check and says when nothing is claimed', () => {
    const { output } = render(result({ checks: result().checks.map(check => ({ ...check, state: 'unknown' as const })), weakestLink: null }))
    for (const check of result().checks)
      expect(output).toContain(check.id)
    expect(nonEmptyLines(output).at(-1)).toContain('nothing is claimed')
    expect(nonEmptyLines(output).filter(line => WEAKEST_LINK_LINE.test(line))).toHaveLength(1)
  })

  it('names the markers still reading back what discovery wrote, above the weakest-link line and without changing the exit code', () => {
    const provenance: MarkerReading[] = [
      { marker: 'product', file: 'AGENTS.md', authorship: 'construct' },
      { marker: 'module-map', file: 'AGENTS.md', authorship: 'owner' },
      { marker: 'composition', file: 'architecture/composition', authorship: 'unknown' },
    ]
    const { output, code } = render(result({ provenance }))
    expect(output).toContain('product')
    expect(output).not.toContain('module-map')
    expect(output).not.toContain('architecture/composition')
    expect(nonEmptyLines(output).at(-1)).toMatch(WEAKEST_LINK_LINE)
    expect(code).toBe(0)
  })

  it('says nothing about provenance when no marker still reads as the construct\'s own', () => {
    const provenance: MarkerReading[] = [{ marker: 'product', file: 'AGENTS.md', authorship: 'owner' }]
    expect(render(result({ provenance })).output).not.toContain('Discovery provenance')
  })

  it('carries no emoji and no lore vocabulary with --plain', () => {
    const { output } = render(result({
      missingFiles: ['AGENTS.md'],
      missingDiscovery: ['product'],
      provenance: [{ marker: 'product', file: 'AGENTS.md', authorship: 'construct' }],
      modifiedFiles: ['CLAUDE.md'],
      warnings: ['node-frontend: `tsc --noEmit` does not see `.vue` components'],
      ok: false,
    }))
    expect(output).not.toMatch(EMOJI)
    for (const word of LORE_VOCABULARY)
      expect(output).not.toContain(word)
  })

  it('exits 1 only for a missing baseline file, a broken harness or a missing construct.json', () => {
    expect(render(result()).code).toBe(0)
    expect(render(result({ weakestLink: { id: 'hook', level: 'L0' } })).code).toBe(0)
    expect(render(result({ missingDiscovery: ['product'], modifiedFiles: ['CLAUDE.md'] })).code).toBe(0)
    expect(render(result({ ok: false, missingFiles: ['AGENTS.md'] })).code).toBe(1)
    expect(render(result({ ok: false, harnessProblems: ['"quality" does not run test'] })).code).toBe(1)
    expect(render(null).code).toBe(1)
  })
})
