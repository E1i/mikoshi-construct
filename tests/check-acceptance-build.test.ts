import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'

const SCRIPT = path.resolve(import.meta.dirname, '..', 'scripts/construct/check-acceptance.mjs')
const BRIEFS_DIR = path.resolve(import.meta.dirname, 'fixtures/briefs')

interface BuiltArgs {
  task: string
  effort: string
  acceptance: string[]
  witnesses: { criterion: string, command: string }[]
  invariants: string[]
  immutable: string[]
}

type Expected = { args: BuiltArgs } | { refusal: string[] }

function runBuild(briefPath: string): { status: number | null, stdout: string, stderr: string } {
  const child = spawnSync(process.execPath, [SCRIPT, 'build', '--brief', briefPath], { encoding: 'utf8' })
  return { status: child.status, stdout: child.stdout, stderr: child.stderr }
}

const cases = readdirSync(BRIEFS_DIR)
  .filter(file => file.endsWith('.md') && file !== 'README.md')
  .map(file => file.replace(/\.md$/, ''))
  .sort()

describe('build mode', () => {
  it('has at least the seven lettered brief fixtures', () => {
    expect(cases.length).toBeGreaterThanOrEqual(7)
  })

  it.each(cases)('turns %s into exactly the expected args, or refuses with the expected reasons', (name) => {
    const brief = path.join(BRIEFS_DIR, `${name}.md`)
    const expected = JSON.parse(readFileSync(path.join(BRIEFS_DIR, `${name}.expected.json`), 'utf8')) as Expected
    const result = runBuild(brief)

    if ('args' in expected) {
      expect(result.status).toBe(0)
      const got = JSON.parse(result.stdout) as BuiltArgs
      expect({
        task: got.task,
        effort: got.effort,
        acceptance: got.acceptance,
        witnesses: got.witnesses,
        invariants: got.invariants,
        immutable: got.immutable,
      }).toEqual(expected.args)
    }
    else {
      expect(result.status).not.toBe(0)
      expect(result.stdout).toBe('')
      for (const text of expected.refusal)
        expect(result.stderr).toContain(text)
    }
  })
})

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const SKILLS = ['.claude/skills/implement/SKILL.md', 'templates/ai/claude/_claude/skills/implement/SKILL.md']
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

function scratch(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'check-acceptance-build-'))
  dirs.push(dir)
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
    writeFileSync(path.join(dir, name), content)
  }
  return dir
}

const CONSTRUCTED = { 'construct.json': JSON.stringify({ harness: { command: 'pnpm run quality' }, contracts: null }) }

function buildIn(dir: string, brief: string): { status: number | null, stdout: string, stderr: string } {
  writeFileSync(path.join(dir, 'brief.md'), brief)
  const child = spawnSync(process.execPath, [SCRIPT, 'build', '--brief', path.join(dir, 'brief.md')], { cwd: dir, encoding: 'utf8' })
  return { status: child.status, stdout: child.stdout, stderr: child.stderr }
}

function built(brief: string): BuiltArgs & { harness: unknown } {
  const result = buildIn(scratch(CONSTRUCTED), brief)
  expect(result.stderr).toBe('')
  expect(result.status).toBe(0)
  return JSON.parse(result.stdout) as BuiltArgs & { harness: unknown }
}

function refused(brief: string): string {
  const result = buildIn(scratch(CONSTRUCTED), brief)
  expect(result.status).not.toBe(0)
  expect(result.stdout).toBe('')
  return result.stderr
}

describe('a label in the brief', () => {
  it('counts right after the end of a sentence on the same line', () => {
    const args = built('Task (#1). Effort: low. Acceptance: one holds — witness: `true`. Invariants: quality stays green.')

    expect(args.effort).toBe('low')
    expect(args.acceptance).toEqual(['one holds'])
    expect(args.invariants).toEqual(['quality stays green'])
  })

  it('is text in the middle of a sentence or inside backticks', () => {
    const args = built([
      'Task (#1).',
      'the word Acceptance: in prose is text, and so is `Invariants: x` quoted',
      'Acceptance: one holds — witness: `true`',
    ].join('\n'))

    expect(args.acceptance).toEqual(['one holds'])
    expect(args.invariants).toEqual([])
  })

  it('ends a section at Mutations with a parenthesis before its colon', () => {
    const args = built('Task.\nAcceptance: one holds — witness: `true`\nImmutable: `src/a.ts`\nMutations (predicted before the run; applied afterwards):\nM1 | src/a.ts | red: W1')

    expect(args.immutable).toEqual(['src/a.ts'])
    expect(args.acceptance).toEqual(['one holds'])
  })
})

describe('an acceptance item', () => {
  it('does not split on a semicolon inside backticks', () => {
    expect(built('Task.\nAcceptance: one holds — witness: `test 1 -eq 1; test 2 -eq 2`; two holds — witness: `true`').witnesses).toEqual([
      { criterion: 'one holds', command: 'test 1 -eq 1; test 2 -eq 2' },
      { criterion: 'two holds', command: 'true' },
    ])
  })

  it('carries its witness, and the criterion is the item before the marker', () => {
    const args = built('Task.\nAcceptance: the  rule\n rejects the case — witness: `pnpm vitest run tests/rule.test.ts`.')

    expect(args.acceptance).toEqual(['the rule rejects the case'])
    expect(args.witnesses).toEqual([{ criterion: 'the rule rejects the case', command: 'pnpm vitest run tests/rule.test.ts' }])
  })

  it('keeps the witness marker text inside a witness command as part of the command', () => {
    expect(built('Task.\nAcceptance: the line is kept — witness: `grep -q \'— witness: kept\' log.txt`').witnesses).toEqual([
      { criterion: 'the line is kept', command: 'grep -q \'— witness: kept\' log.txt' },
    ])
  })

  it('reads the witness after the last marker outside backticks, even when the criterion quotes the marker', () => {
    expect(built('Task.\nAcceptance: the doc names `— witness:` — witness: `true`').witnesses).toEqual([
      { criterion: 'the doc names `— witness:`', command: 'true' },
    ])
  })

  it('with no witness is refused, naming the item and the reason', () => {
    const stderr = refused('Task.\nAcceptance: one holds — witness: `true`; two has nothing')

    expect(stderr).toContain('no witness')
    expect(stderr).toContain('two has nothing')
  })

  it('with a backtick inside its witness is refused, naming the item and the reason, never cut', () => {
    const stderr = refused('Task.\nAcceptance: the name is printed — witness: `echo `name``')

    expect(stderr).toContain('backtick')
    expect(stderr).toContain('the name is printed')
  })

  it('is required: a brief with no acceptance is refused', () => {
    expect(refused('Task.\nInvariants: quality stays green')).toContain('no Acceptance: section')
  })
})

describe('the harness in the built args', () => {
  const brief = 'Task.\nAcceptance: one holds — witness: `true`'

  it('comes from construct.json, with its contracts and the Contract paths line in AGENTS.md', () => {
    const dir = scratch({
      'construct.json': JSON.stringify({ harness: { command: 'pnpm run quality' }, contracts: { path: 'contract/openapi.yaml', types: 'src/contracts/openapi.ts' } }),
      'AGENTS.md': '# Project\n\nContract paths: contract/surface.json, contract/events.json\n',
    })

    expect(JSON.parse(buildIn(dir, brief).stdout).harness).toEqual({
      command: 'pnpm run quality',
      extra: [],
      contractPaths: ['contract/openapi.yaml', 'src/contracts/openapi.ts', 'contract/surface.json', 'contract/events.json'],
      contractCheck: '',
    })
  })

  it('comes from .construct/attach.json when construct.json is absent, with contract paths from AGENTS.md only', () => {
    const dir = scratch({
      '.construct/attach.json': JSON.stringify({ harness: { command: 'make check' } }),
      'AGENTS.md': 'Contract paths: api/openapi.yaml\n',
    })

    expect(JSON.parse(buildIn(dir, brief).stdout).harness).toEqual({ command: 'make check', extra: [], contractPaths: ['api/openapi.yaml'], contractCheck: '' })
  })

  it('reads Contract paths and Contract check from AGENTS.md', () => {
    const dir = scratch({
      'construct.json': JSON.stringify({ harness: { command: 'make check' }, contracts: { path: 'api/openapi.yaml', types: 'src/api.ts' } }),
      'AGENTS.md': '<!-- construct:end -->\n\nContract paths: contract/surface.json, contract/events.json\nContract check: make contract-marker-283\n',
      'CLAUDE.md': 'Contract paths: claude/only.json\nContract check: make claude-marker\n',
    })

    expect(JSON.parse(buildIn(dir, brief).stdout).harness).toEqual({
      command: 'make check',
      extra: [],
      contractPaths: ['api/openapi.yaml', 'src/api.ts', 'contract/surface.json', 'contract/events.json'],
      contractCheck: 'make contract-marker-283',
    })
  })

  it('refuses a contract line found only in CLAUDE.md', () => {
    const pathsResult = buildIn(scratch({
      ...CONSTRUCTED,
      'AGENTS.md': '<!-- construct:end -->\n',
      'CLAUDE.md': 'Contract paths: contract/surface.json\n',
    }), brief)
    expect(pathsResult.status).not.toBe(0)
    expect(pathsResult.stdout).toBe('')
    expect(pathsResult.stderr).toContain('Contract paths: contract/surface.json')
    expect(pathsResult.stderr).toContain('moved to AGENTS.md')

    const checkResult = buildIn(scratch({
      ...CONSTRUCTED,
      'AGENTS.md': '<!-- construct:end -->\n\nContract paths: contract/surface.json\n',
      'CLAUDE.md': 'Contract check: pnpm contract:bump\n',
    }), brief)
    expect(checkResult.status).not.toBe(0)
    expect(checkResult.stdout).toBe('')
    expect(checkResult.stderr).toContain('Contract check: pnpm contract:bump')
    expect(checkResult.stderr).toContain('moved to AGENTS.md')
  })

  it('is refused when neither record names a harness command', () => {
    const result = buildIn(scratch({}), brief)

    expect(result.status).not.toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('no harness command')
  })
})

describe('one parser serves both modes', () => {
  const accepted = cases.filter(name => 'args' in (JSON.parse(readFileSync(path.join(BRIEFS_DIR, `${name}.expected.json`), 'utf8')) as Expected))

  it('has briefs the build accepts', () => {
    expect(accepted.length).toBeGreaterThan(0)
  })

  it.each(accepted)('the check mode accepts what the build prints for %s', (name) => {
    const brief = path.join(BRIEFS_DIR, `${name}.md`)
    const result = runBuild(brief)
    expect(result.status).toBe(0)
    const dir = scratch({ 'args.json': result.stdout })
    const check = spawnSync(process.execPath, [SCRIPT, '--agreed', brief, '--args', path.join(dir, 'args.json')], { encoding: 'utf8' })

    expect(check.stderr).toBe('')
    expect(check.status).toBe(0)
  })
})

describe('the /implement skill', () => {
  for (const skill of SKILLS) {
    it(`${skill} passes the build's args to the Workflow unchanged and never runs the check mode`, () => {
      const text = readFileSync(path.join(REPO_ROOT, skill), 'utf8')

      expect(text).toContain('check-acceptance.mjs build --brief .construct/implement-agreed.txt > .construct/implement-args.json')
      expect(text).toContain('`.construct/implement-args.json`, unchanged')
      expect(text).not.toContain('--agreed')
    })
  }
})
