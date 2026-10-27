import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'vitest'
import { fileEditingMarks, harnessCandidates, throughPackageRunners, unresolvedCommandWord } from '../src/commands/attach/harness.js'
import { pickedCandidate } from '../src/ui/prompts.js'

function executable(directory: string, name: string): void {
  mkdirSync(directory, { recursive: true })
  const file = path.join(directory, name)
  writeFileSync(file, '#!/bin/sh\nexit 0\n')
  chmodSync(file, 0o755)
}

const root = mkdtempSync(path.join(tmpdir(), 'construct-attach-harness-'))
const bin = path.join(root, 'bin')
const cwdLike = path.join(root, 'repo')
executable(bin, 'pnpm')
executable(cwdLike, 'quality')
const SEARCH_PATH = [bin, '', '.', path.relative(process.cwd(), cwdLike)].join(path.delimiter)

const COMMANDS: Record<string, string | null> = {
  'pnpm quality': null,
  './run.sh': null,
  'CI=1 vitest run': 'vitest',
  'quality': 'quality',
  'cd app && pnpm test': null,
  '  pnpm run quality  ': null,
}

describe('attach names the first word of a harness command that PATH does not resolve', () => {
  for (const [command, word] of Object.entries(COMMANDS)) {
    it(`${JSON.stringify(command)} → ${word ?? 'resolves'}`, () => {
      expect(unresolvedCommandWord(command, SEARCH_PATH)).toBe(word)
    })
  }

  it('does not count an executable reached only through a relative PATH entry', () => {
    expect(unresolvedCommandWord('quality', [cwdLike, bin].join(path.delimiter))).toBeNull()
    expect(unresolvedCommandWord('quality', SEARCH_PATH)).toBe('quality')
  })
})

describe('the next step keeps the rest of the command and puts a package runner before the word', () => {
  it('a bare script name', () => {
    expect(throughPackageRunners('quality', 'quality')).toEqual(['npm run quality', 'npx quality'])
  })

  it('an environment assignment and arguments stay where they were', () => {
    expect(throughPackageRunners('CI=1 vitest run', 'vitest')).toEqual(['CI=1 npm run vitest run', 'CI=1 npx vitest run'])
  })
})

const EDITS: Record<string, string[]> = {
  'pnpm run quality': [],
  'pnpm lint:fix': ['lint:fix'],
  'npx eslint . --fix': ['--fix'],
  'prettier --write . && pnpm test': ['--write'],
  'pnpm lint:fix && eslint . --fix': ['lint:fix', '--fix'],
  'eslint --fix-dry-run .': [],
}

describe('attach names what makes a harness command edit files', () => {
  for (const [command, marks] of Object.entries(EDITS)) {
    it(`${JSON.stringify(command)} → ${marks.length === 0 ? 'nothing' : marks.join(', ')}`, () => {
      expect(fileEditingMarks(command)).toEqual(marks)
    })
  }
})

function repository(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'construct-attach-candidates-'))
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
    writeFileSync(path.join(dir, file), content)
  }
  return dir
}

const CI = [
  'name: ci',
  'on: [push]',
  'jobs:',
  '  check:',
  '    runs-on: ubuntu-latest',
  '    steps:',
  '      - uses: actions/checkout@v4',
  '      - run: pnpm install --frozen-lockfile',
  '      - run: pnpm lint',
  '      - run: pnpm test',
  '',
].join('\n')

const MONOREPO = {
  'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
  'pnpm-lock.yaml': 'lockfileVersion: \'9.0\'\n',
  'package.json': JSON.stringify({ name: 'mono', private: true, scripts: { lint: 'eslint .', typecheck: 'tsc --noEmit', test: 'vitest run', build: 'tsc -b' } }),
  'packages/app/package.json': JSON.stringify({ name: 'app', scripts: { test: 'vitest run' } }),
  '.github/workflows/ci.yml': CI,
}

describe('attach proposes harness candidates read from the repository', () => {
  it('on a monorepo, the CI step pnpm test comes first with its workflow line, and lint is not among them', () => {
    const candidates = harnessCandidates(repository(MONOREPO))
    expect(candidates[0]).toEqual({ command: 'pnpm test', source: '.github/workflows/ci.yml:10', job: 'check' })
    expect(candidates.map(candidate => candidate.command).filter(command => command.includes('lint'))).toEqual([])
  })

  it('the package script that repeats a CI step is not proposed twice, and typecheck ranks after tests', () => {
    expect(harnessCandidates(repository(MONOREPO))).toEqual([
      { command: 'pnpm test', source: '.github/workflows/ci.yml:10', job: 'check' },
      { command: 'pnpm run typecheck', source: 'package.json scripts.typecheck' },
    ])
  })

  it('a CI step that calls a script whose body runs tests is a test candidate', () => {
    const dir = repository({
      'package.json': JSON.stringify({ packageManager: 'pnpm@12.4.2', scripts: { quality: 'pnpm lint && pnpm test', lint: 'eslint .', test: 'vitest run' } }),
      '.github/workflows/ci.yml': 'jobs:\n  ci:\n    steps:\n      - name: gate\n        run: |\n          pnpm install\n          pnpm run quality\n',
    })
    expect(harnessCandidates(dir)).toEqual([
      { command: 'pnpm run quality', source: '.github/workflows/ci.yml:7', job: 'ci' },
      { command: 'pnpm run test', source: 'package.json scripts.test' },
    ])
  })

  it('a test script written after the typecheck script still comes first', () => {
    const dir = repository({ 'package.json': JSON.stringify({ scripts: { 'check-types': 'tsc --noEmit', 'typecheck': 'tsc --noEmit', 'test': 'node --test' } }) })
    expect(harnessCandidates(dir).map(candidate => candidate.command)).toEqual(['npm run test', 'npm run typecheck'])
  })

  it('prints at most three, and npm runs the scripts when nothing names another manager', () => {
    const dir = repository({ 'package.json': JSON.stringify({ scripts: { 'test': 'a', 'test:unit': 'b', 'test:e2e': 'c', 'test:int': 'd' } }) })
    expect(harnessCandidates(dir).map(candidate => candidate.command)).toEqual(['npm run test', 'npm run test:unit', 'npm run test:e2e'])
  })

  it('a repository with no tests proposes nothing', () => {
    expect(harnessCandidates(repository({ 'package.json': JSON.stringify({ scripts: { lint: 'eslint .', build: 'tsc' } }), 'main.go': 'package main\n' }))).toEqual([])
  })
})

const ANSWERS: Record<string, number | null | undefined> = {
  yes: 0,
  Y: 0,
  no: null,
  n: null,
  2: 1,
  3: 2,
  4: undefined,
  0: undefined,
  maybe: undefined,
}

describe('the candidate question takes yes, no or a number', () => {
  for (const [answer, picked] of Object.entries(ANSWERS)) {
    it(`${JSON.stringify(answer)} of three → ${picked === undefined ? 'asked again' : picked === null ? 'none of them' : `candidate ${picked + 1}`}`, () => {
      expect(pickedCandidate(answer, 3)).toBe(picked)
    })
  }
})

const workflow = (...lines: string[]): string => `${lines.join('\n')}\n`

const JOB_READINGS: Record<string, { text: string, expected: { job?: string, jobUnresolved?: true } }> = {
  'a workflow indented by four spaces': {
    text: workflow('jobs:', '    build:', '        name: Four wide', '        steps:', '            - run: pnpm test'),
    expected: { job: 'Four wide' },
  },
  'a quoted name': {
    text: workflow('jobs:', '  build:', '    name: "Build and test"', '    steps:', '      - run: pnpm test'),
    expected: { job: 'Build and test' },
  },
  'a single-quoted name': {
    text: workflow('jobs:', '  build:', '    name: \'Build, test\'', '    steps:', '      - run: pnpm test'),
    expected: { job: 'Build, test' },
  },
  'no name, so the id is the check run': {
    text: workflow('jobs:', '  build:', '    runs-on: ubuntu-latest', '    steps:', '      - run: pnpm test'),
    expected: { job: 'build' },
  },
  'a step name that must not be taken': {
    text: workflow('jobs:', '  build:', '    steps:', '      - name: Run the tests', '        run: pnpm test'),
    expected: { job: 'build' },
  },
  'a step name after the run line of the same step': {
    text: workflow('jobs:', '  build:', '    steps:', '      - run: pnpm test', '        name: Run the tests'),
    expected: { job: 'build' },
  },
  'a block scalar run under a named job': {
    text: workflow('jobs:', '  build:', '    name: Gate', '    steps:', '      - run: |', '          pnpm install', '          pnpm test'),
    expected: { job: 'Gate' },
  },
  'the second of several jobs': {
    text: workflow('jobs:', '  lint:', '    name: Lint it', '    steps:', '      - run: pnpm lint', '  test:', '    name: Test it', '    steps:', '      - run: pnpm test', '  deploy:', '    name: Ship it', '    steps:', '      - run: pnpm deploy'),
    expected: { job: 'Test it' },
  },
  'a matrix job': {
    text: workflow('jobs:', '  test:', '    name: Test', '    strategy:', '      matrix:', '        node: [20, 22]', '    steps:', '      - run: pnpm test'),
    expected: { jobUnresolved: true },
  },
  'a matrix job with no name': {
    text: workflow('jobs:', '  test:', '    strategy:', '      matrix:', '        node: [20, 22]', '    steps:', '      - run: pnpm test'),
    expected: { jobUnresolved: true },
  },
  'a name that holds an expression': {
    text: workflow('jobs:', '  test:', `    name: Test on \${{ inputs.os }}`, '    steps:', '      - run: pnpm test'),
    expected: { jobUnresolved: true },
  },
  'a job that calls a reusable workflow': {
    text: workflow('jobs:', '  test:', '    uses: ./.github/workflows/reusable.yml', '    steps:', '      - run: pnpm test'),
    expected: { jobUnresolved: true },
  },
}

describe('attach reads the job a candidate was taken from', () => {
  for (const [name, { text, expected }] of Object.entries(JOB_READINGS)) {
    it(`${name}`, () => {
      const dir = repository({ '.github/workflows/ci.yml': text })
      const found = harnessCandidates(dir).find(candidate => candidate.command === 'pnpm test')
      expect(found).toEqual({ command: 'pnpm test', source: expect.stringContaining('.github/workflows/ci.yml:'), ...expected })
    })
  }

  it('a job beside a matrix job keeps its own name', () => {
    const dir = repository({ '.github/workflows/ci.yml': workflow('jobs:', '  matrix:', '    strategy:', '      matrix:', '        node: [20]', '    steps:', '      - run: pnpm lint', '  test:', '    name: Plain', '    steps:', '      - run: pnpm test') })
    expect(harnessCandidates(dir).find(candidate => candidate.command === 'pnpm test')?.job).toBe('Plain')
  })
})
