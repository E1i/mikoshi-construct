import type { Graph, Run } from '../../ci/layers.js'
import type { SandboxFailing } from '../../ci/sandbox-failing.js'
import type { VitestRun } from '../../ci/test-command.js'
import type { VitestReport } from '../../ci/vitest-report.js'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import YAML from 'yaml'
import { BUS_SERVICE, BUS_SHARED, selectRun } from '../../ci/layers.js'
import { CI_DIFF, ciArgs, prepushGate, sessionArgs, testsVerdict } from '../../ci/prepush.js'
import { SANDBOX_FAILING } from '../../ci/sandbox-failing.js'
import { missingInCi, staleInSandbox } from '../../ci/sandbox-liveness.js'
import { reportedRun, runSummary } from '../../ci/select.js'
import { PASS_WITH_NO_TESTS, RETRY, testScript } from '../../ci/test-command.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..')

interface Step { id?: string, if?: string, run?: string, env?: Record<string, string> }
interface Job { if?: string, needs?: string | string[], outputs?: Record<string, string>, steps: Step[] }
const workflow = YAML.parse(readFileSync(path.join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8')) as { jobs: Record<string, Job> }

interface ProbedPr { pr: number, merged: string, ciRun: number, ciSummary: string, changed: string[] }
const PROBED: ProbedPr[] = JSON.parse(readFileSync(path.join(import.meta.dirname, 'fixtures', 'prepush-prs.json'), 'utf8')) as ProbedPr[]

const VITEST_STEP = workflow.jobs.vitest!.steps.find(step => step.run?.startsWith('pnpm test ') === true)!
const SELECT_STEP = workflow.jobs.changes!.steps.find(step => step.id === 'select')!

function expression(body: string): string {
  return `\${{ ${body} }}`
}

function ciCommand(run: Run): string {
  const env: Record<string, string> = {
    SELECTED_TESTS: run.kind === 'layers' ? run.tests.join(' ') : '',
    PASS_WITH_NO_TESTS: run.kind === 'layers' ? PASS_WITH_NO_TESTS : '',
  }
  return VITEST_STEP.run!
    .replace(/--shard=\$\{\{ matrix\.shard \}\}\/\d+/, '')
    .replace(/\$(\w+)/g, (_, name: string) => env[name] ?? '')
    .split(/\s+/)
    .filter(arg => arg !== '' && !arg.startsWith('--reporter='))
    .join(' ')
}

function report(tests: { file: string, name: string, status: string, messages?: string[] }[]): VitestReport {
  const files = [...new Set(tests.map(test => test.file))]
  return {
    testResults: files.map(file => ({
      name: path.join(REPO_ROOT, file),
      status: tests.some(test => test.file === file && test.status === 'failed') ? 'failed' : 'passed',
      assertionResults: tests.filter(test => test.file === file).map(test => ({ ancestorTitles: [], title: test.name, status: test.status, failureMessages: test.messages ?? [] })),
    })),
  }
}

function vitestRun(status: number, tests: Parameters<typeof report>[0]): VitestRun {
  return { status, report: report(tests), error: null }
}

const NOTES_GRAPH: Graph = new Map([
  ['scripts/notes/print.ts', []],
  ['scripts/notes/parse.ts', []],
  ['scripts/tests/notes/print.test.ts', ['scripts/notes/print.ts']],
  ['scripts/tests/notes/parse.test.ts', ['scripts/notes/parse.ts']],
  ['scripts/tests/core/events.test.ts', []],
])
const SCANNER_TEXT = 'readdirSync(path.join(ROOT, \'scripts\'))'

const BUS_DIR = 'scripts/bus'
const BUS_IMPORT = /from '\.\/([\w-]+)\.js'/g

function importedByMostNodeKinds(): string[] {
  const nodes = readdirSync(path.join(REPO_ROOT, BUS_DIR)).map(file => `${BUS_DIR}/${file}`).filter(file => BUS_SERVICE.test(file))
  const kinds = new Map<string, Set<string>>()
  for (const node of nodes) {
    const kind = BUS_SERVICE.exec(node)![1]!
    const imports = kinds.get(kind) ?? new Set<string>()
    for (const [, name] of readFileSync(path.join(REPO_ROOT, node), 'utf8').matchAll(BUS_IMPORT))
      imports.add(`${BUS_DIR}/${name}.ts`)
    kinds.set(kind, imports)
  }
  const modules = [...new Set([...kinds.values()].flatMap(imports => [...imports]))]
  return modules.filter(module => [...kinds.values()].filter(imports => imports.has(module)).length * 2 > kinds.size).sort()
}

const LISTED: SandboxFailing[] = [
  { file: 'scripts/tests/notes/print.test.ts', test: 'print > spawns ps', refused: 'spawnSync ps EPERM' },
  { file: 'scripts/tests/notes/spawn.test.ts', test: '', refused: 'listen EPERM on the tsx IPC pipe' },
]

describe('the session pre-push runs the CI selector over the session diff', () => {
  it('on PR #1037, PR #1039 and PR #1036 the session and CI run the same test set with the same command and environment', () => {
    expect(SELECT_STEP.run).toContain(`git ${CI_DIFF.join(' ')} HEAD^1 HEAD | pnpm exec tsx scripts/ci/select.ts --stdin`)
    expect(VITEST_STEP.env).toEqual({
      SELECTED_TESTS: expression('needs.changes.outputs.full == \'false\' && needs.changes.outputs.tests || \'\''),
      PASS_WITH_NO_TESTS: expression('needs.changes.outputs.full == \'false\' && \'--passWithNoTests\' || \'\''),
    })
    expect(testScript()).toEqual(['node', '--import', 'tsx', 'scripts/scratch/run.ts', 'vitest', 'run'])
    expect(PROBED.map(probed => probed.pr)).toEqual([1037, 1039, 1036])
    for (const probed of PROBED) {
      const session = reportedRun(selectRun([...probed.changed].sort(), new Map(), () => ''))
      expect(runSummary(session)).toBe(probed.ciSummary)
      expect(ciCommand(session)).toBe(['pnpm', 'test', ...ciArgs(session)].join(' '))
      const args = sessionArgs(session, SANDBOX_FAILING)
      expect(args.slice(0, ciArgs(session).length)).toEqual(ciArgs(session))
      const leftOut = args.slice(ciArgs(session).length)
      const excluded = leftOut.filter((_, index) => leftOut[index - 1] === '--exclude')
      expect(excluded).toEqual(SANDBOX_FAILING.filter(entry => entry.test === '').map(entry => entry.file))
      expect(leftOut.filter(arg => arg !== '--exclude' && !excluded.includes(arg))).toEqual(['-t', expect.stringMatching(/^\^\(\?!\(\?:/)])
    }
  })

  it('a diff on a shared bus file selects every test under scripts/tests/bus', () => {
    expect(BUS_SHARED).toEqual(importedByMostNodeKinds())
    const graph: Graph = new Map([
      ['scripts/core/queue.ts', []],
      ['scripts/nodes/merge/merge-worker.ts', []],
      ['scripts/tests/bus/merge-worker.test.ts', ['scripts/nodes/merge/merge-worker.ts']],
      ['scripts/tests/bus/board.test.ts', []],
      ['scripts/tests/notes/print.test.ts', []],
    ])
    const run = selectRun(['scripts/core/queue.ts'], graph, () => '')
    expect(run).toEqual({ kind: 'layers', layers: ['bus'], tests: ['scripts/tests/bus/board.test.ts', 'scripts/tests/bus/merge-worker.test.ts'] })
    expect(selectRun(['scripts/nodes/merge/merge-worker.ts'], graph, () => '')).toEqual({ kind: 'layers', layers: ['bus:merge'], tests: ['scripts/tests/bus/merge-worker.test.ts'] })
  })

  it('a red local test leaves the push undone', () => {
    const red = testsVerdict(vitestRun(1, [{ file: 'scripts/tests/notes/print.test.ts', name: 'prints', status: 'failed' }]))
    const gate = prepushGate(['scripts/notes/print.ts'], () => red, () => [])
    expect(gate.code).toBe(1)
    expect(gate.lines).toEqual([
      'prepush: red — the push does not happen; fix these in this session and run the gate again:',
      'failed: scripts/tests/notes/print.test.ts > prints',
    ])
  })

  it('a broken test command is a block with a finding and a question', () => {
    for (const broken of [{ status: null, report: null, error: 'spawn node ENOENT' }, { status: 1, report: null, error: null }, { status: 1, report: { testResults: [] }, error: null }, vitestRun(1, [{ file: 'scripts/tests/notes/print.test.ts', name: 'prints', status: 'skipped' }])] satisfies VitestRun[]) {
      const gate = prepushGate(['scripts/notes/print.ts'], () => testsVerdict(broken), () => [])
      expect(gate.code).toBe(2)
      expect(gate.lines[0]).toBe('prepush: broken — the push does not happen.')
      expect(gate.lines[1]).toMatch(/^finding: the pre-push test command is broken: /)
      expect(gate.lines[2]).toMatch(/^question: .*the card does not repair product code to get past it\.$/)
    }
  })

  it('an edit of one function runs locally only its related tests and the global scanners while CI still runs the layer', () => {
    const run = selectRun(['scripts/notes/print.ts'], NOTES_GRAPH, test => test === 'scripts/tests/core/events.test.ts' ? SCANNER_TEXT : '')
    expect(run).toEqual({ kind: 'layers', layers: ['notes'], tests: ['scripts/tests/core/events.test.ts', 'scripts/tests/notes/print.test.ts'] })
    expect(sessionArgs(run, [])).toEqual(['scripts/tests/core/events.test.ts', 'scripts/tests/notes/print.test.ts', PASS_WITH_NO_TESTS, RETRY])
    expect(SELECT_STEP.if).toBe('github.event_name == \'pull_request\' && !startsWith(github.head_ref, \'changeset-release/\')')
    expect(workflow.jobs.changes!.outputs!.full).toBe(expression('steps.select.outputs.full || \'true\''))
    expect(ciCommand({ kind: 'full', why: 'merge_group' })).toBe(`pnpm test ${RETRY}`)
  })

  it('a test on the sandbox list is not run in the session and is run in CI', () => {
    const run: Run = { kind: 'layers', layers: ['notes'], tests: ['scripts/tests/notes/print.test.ts', 'scripts/tests/notes/spawn.test.ts'] }
    expect(ciArgs(run)).toEqual(['scripts/tests/notes/print.test.ts', 'scripts/tests/notes/spawn.test.ts', PASS_WITH_NO_TESTS, RETRY])
    expect(sessionArgs(run, LISTED)).toEqual([...ciArgs(run), '--exclude', 'scripts/tests/notes/spawn.test.ts', '-t', '^(?!(?:print > spawns ps)$)'])
    const pattern = new RegExp(sessionArgs(run, LISTED).at(-1)!)
    expect(pattern.test('print > spawns ps')).toBe(false)
    expect(pattern.test('print > spawns ps and more')).toBe(true)
    expect(missingInCi(LISTED, [{ file: 'scripts/tests/notes/print.test.ts', name: 'print > spawns ps' }, { file: 'scripts/tests/notes/spawn.test.ts', name: 'spawn > %s' }])).toEqual([])
    for (const entry of SANDBOX_FAILING)
      expect(existsSync(path.join(REPO_ROOT, entry.file)), entry.file).toBe(true)
  })

  it('a new red test outside the sandbox list blocks the push', () => {
    const run: Run = { kind: 'layers', layers: ['notes'], tests: ['scripts/tests/notes/print.test.ts'] }
    expect(sessionArgs(run, LISTED)).not.toContain('scripts/tests/notes/parse.test.ts')
    const verdict = testsVerdict(vitestRun(1, [
      { file: 'scripts/tests/notes/print.test.ts', name: 'print > prints', status: 'passed' },
      { file: 'scripts/tests/notes/print.test.ts', name: 'print > reads a pid', status: 'failed', messages: ['Error: spawnSync ps EPERM'] },
    ]))
    expect(verdict).toEqual({ kind: 'red', failed: ['scripts/tests/notes/print.test.ts > print > reads a pid'] })
    expect(prepushGate(['scripts/notes/print.ts'], () => verdict, () => []).code).toBe(1)
  })

  it('a listed test that stopped failing turns the liveness check red on a pull request of the list while an ordinary card push passes', () => {
    const outcomes = [
      { file: 'scripts/tests/notes/print.test.ts', name: 'print > spawns ps', state: 'passed', messages: [] },
      { file: 'scripts/tests/notes/spawn.test.ts', name: '', state: 'failed', messages: ['Error: listen EPERM: operation not permitted /var/folders/x/T/tsx-501/1234.pipe'] },
    ]
    const stale = staleInSandbox(LISTED, outcomes, [])
    expect(stale).toEqual([{ entry: LISTED[0], why: 'no longer fails in the session sandbox: it passed' }])
    const green = () => testsVerdict(vitestRun(0, [{ file: 'scripts/tests/notes/parse.test.ts', name: 'parses', status: 'passed' }]))
    const ofTheList = prepushGate(['scripts/ci/sandbox-failing.jsonl'], green, () => stale)
    expect(ofTheList.code).toBe(1)
    expect(ofTheList.lines).toContain('stale: scripts/tests/notes/print.test.ts > print > spawns ps — no longer fails in the session sandbox: it passed')
    const liveness = vi.fn(() => stale)
    const ordinary = prepushGate(['scripts/notes/parse.ts'], green, liveness)
    expect(ordinary).toEqual({ lines: ['prepush: green — 1 tests ran; the push may go.'], code: 0 })
    expect(liveness).not.toHaveBeenCalled()
    expect(workflow.jobs['sandbox-list']!.steps.at(-1)).toEqual({ if: 'needs.changes.outputs.liveness == \'true\'', run: 'pnpm exec tsx scripts/ci/sandbox-liveness.ts --ci' })
  })
})
