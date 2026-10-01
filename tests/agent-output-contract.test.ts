import type { ContourSchema } from '../scripts/contract/contours.js'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { violations } from '../scripts/contract/contours.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const WORKFLOW = 'scripts/construct/implement.workflow'
const AGENT_DIRS = ['.claude/agents', 'templates/ai/claude/_claude/agents']
const SCHEMA_OF_AGENT = { architect: 'SPEC', implementer: 'REPORT', harness: 'VERDICT' } as const
const ROLE_AGENTS_OF_DIR: Record<string, string[]> = { '.claude/agents': ['brief', 'review', 'scan'] }

function read(file: string): string {
  return readFileSync(path.join(REPO_ROOT, file), 'utf8')
}

function schema(name: string): ContourSchema {
  const source = read(WORKFLOW)
  const literal = new RegExp(`^const ${name} = (\\{[\\s\\S]*?^\\})$`, 'm').exec(source)?.[1]
  expect(literal, `${name} is declared in ${WORKFLOW}`).toBeTruthy()
  // eslint-disable-next-line no-new-func
  return new Function(`return (${literal})`)() as ContourSchema
}

const AWKWARD = '— an em dash, 🦾 an emoji, and a nested fence:\n```json\n{ "not": "the contract" }\n```\n'

const FIXTURES: Record<string, Record<string, unknown>> = {
  SPEC: {
    decision: `Keep the contract in one place ${AWKWARD}`,
    contractChanges: `none ${AWKWARD}`,
    compositionChanges: '',
    constraints: [`no fenced example ${AWKWARD}`],
    acceptance: [`the schema validates ${AWKWARD}`],
    files: ['.claude/agents/architect.md'],
  },
  REPORT: {
    status: 'done',
    summary: `Removed the duplicate ${AWKWARD}`,
    files: [`tests/agent-output-contract.test.ts ${AWKWARD}`],
    harnessTail: `pnpm run quality ${AWKWARD}`,
    question: '',
  },
  VERDICT: {
    passed: true,
    failureExcerpt: `none ${AWKWARD}`,
    securityFinding: '',
    diffStat: ` 2 files changed ${AWKWARD}`,
    testsWeakened: false,
    changedFiles: [`contract/surface.json ${AWKWARD}`],
    baseSha: '36f7abc9815cea1962b05bcf98bdcec193ba9fc5',
    baseInstall: { command: 'pnpm install --frozen-lockfile', exitCode: 0 },
    argsSha256: 'a'.repeat(64),
    witnesses: [{ criterion: `the reader parses ${AWKWARD}`, command: 'pnpm vitest run tests/reader.test.ts', afterExitCode: 0, afterExcerpt: `1 passed ${AWKWARD}`, baseExitCode: 1, baseExcerpt: `1 failed ${AWKWARD}`, ranSha256: '36f7abc9815cea1962b05bcf98bdcec193ba9fc5' }],
  },
}

describe('the output contract is declared once, by the schema', () => {
  for (const directory of AGENT_DIRS) {
    const roleAgents = ROLE_AGENTS_OF_DIR[directory] ?? []
    const files = readdirSync(path.join(REPO_ROOT, directory)).filter(entry => entry.endsWith('.md')).map(entry => entry.replace(/\.md$/, ''))
    const agents = files.filter(agent => !roleAgents.includes(agent))
    it(`${directory} holds an agent file for every schema the ladder passes, and besides them only its declared role agents`, () => {
      expect(files.sort()).toEqual([...Object.keys(SCHEMA_OF_AGENT), ...roleAgents].sort())
    })

    for (const agent of agents) {
      const schemaName = SCHEMA_OF_AGENT[agent as keyof typeof SCHEMA_OF_AGENT]
      const file = `${directory}/${agent}.md`

      it(`${file} carries no fenced block and no instruction to format the final message as JSON`, () => {
        const source = read(file)
        expect(source).not.toMatch(/^```/m)
        expect(source).not.toMatch(/JSON object/i)
        expect(source).not.toMatch(/data, not prose/i)
      })

      it(`${file} names every field ${schemaName} requires`, () => {
        const source = read(file)
        const required = schema(schemaName).required ?? []
        expect(required.length).toBeGreaterThan(0)
        expect(required.filter(key => !source.includes(`\`${key}\``))).toEqual([])
      })
    }
  }

  it('keeps the repository agent files and the templates that ship to users in step', () => {
    for (const agent of Object.keys(SCHEMA_OF_AGENT))
      expect(read(`${AGENT_DIRS[1]}/${agent}.md`)).toBe(read(`${AGENT_DIRS[0]}/${agent}.md`))
    expect(read(`templates/ai/claude/${WORKFLOW}`)).toBe(read(WORKFLOW))
  })
})

describe('the harness reports what changed and never judges a contract change', () => {
  it('has no contractChanged property in VERDICT and requires changedFiles as an array of strings', () => {
    const verdict = schema('VERDICT')
    expect(Object.keys(verdict.properties ?? {})).not.toContain('contractChanged')
    expect(verdict.required).not.toContain('contractChanged')
    expect(verdict.required).toContain('changedFiles')
    expect(verdict.properties?.changedFiles).toEqual({ type: 'array', items: { type: 'string' } })
  })

  it('lists changed files against the base sha, so a change the implementer committed is not hidden by HEAD', () => {
    const agent = read('.claude/agents/harness.md')
    expect(agent).toContain('`git diff --name-only <base>`')
    expect(agent).not.toContain('git diff --name-only HEAD')
  })
})

describe('the harness reads a skipped test as weakened in pytest as well as in vitest', () => {
  for (const dir of AGENT_DIRS) {
    it(`${dir}/harness.md names the pytest skip and xfail forms, including the bare decorator`, () => {
      const agent = read(`${dir}/harness.md`)
      for (const form of ['`.skip(`', '`@pytest.mark.skip`', '`@pytest.mark.skipif`', '`@pytest.mark.xfail`', '`pytest.skip(`', '`pytest.xfail(`'])
        expect(agent).toContain(form)
      expect(agent).toContain('with or without parentheses')
    })
  }
})

describe('the schema survives awkward values', () => {
  for (const [name, fixture] of Object.entries(FIXTURES)) {
    it(`${name} accepts an em dash, an emoji and a nested triple-backtick sequence with no manual escaping`, () => {
      const target = schema(name)
      expect(violations(fixture, target)).toEqual([])
      expect(violations(JSON.parse(JSON.stringify(fixture)), target)).toEqual([])
      expect(JSON.parse(JSON.stringify(fixture))).toEqual(fixture)
    })
  }

  it('names the offending field when a value has the wrong type', () => {
    expect(violations({ ...FIXTURES.REPORT, files: 'tests/agent-output-contract.test.ts' }, schema('REPORT')))
      .toEqual(['files: expected array'])
  })

  it('names the offending field when a value is outside the enum', () => {
    expect(violations({ ...FIXTURES.REPORT, status: 'finished' }, schema('REPORT')))
      .toEqual(['status: expected one of "done", "failed", "blocked"'])
  })

  it('names the offending field when it is missing', () => {
    const { diffStat, ...withoutDiffStat } = FIXTURES.VERDICT
    expect(diffStat).toBeTypeOf('string')
    expect(violations(withoutDiffStat, schema('VERDICT'))).toEqual(['diffStat: missing'])
  })
})

describe('the ladder records every failed attempt and retries with the validator complaint', () => {
  const source = read(WORKFLOW)

  it('reads the retry limit from the workflow arguments and defaults to not re-asking', () => {
    expect(source).toMatch(/args\.retryLimit/)
    expect(source).toMatch(/DEFAULT_RETRY_LIMIT = 0/)
  })

  it('passes the validator error text into the retry prompt', () => {
    expect(source).toMatch(/The validator reported:\\n\$\{validationError\}/)
  })

  it('distinguishes a schema failure from a harness failure and from a blocked report', () => {
    for (const outcome of ['schema invalid', 'harness failed', 'blocked'])
      expect(source).toContain(`'${outcome}'`)
    expect(source).not.toContain('no report')
    expect(source).toMatch(/reason: lastValidationError/)
  })
})
