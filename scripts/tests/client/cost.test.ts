import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { sessionTokens } from '../../../src/commands/cost/cheap.js'
import { readDaemonObjects } from '../../../src/commands/cost/daemon.js'
import { costJson, costReport } from '../../../src/commands/cost/index.js'
import { costSourceFor, projectKey, recordingSource } from '../../../src/commands/cost/source.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')
const REGISTRY = 'src/commands/cost/source.ts'
const CLOSED_BYPASSES = [
  'src/commands/cost/bus.ts',
  'src/commands/cost/cheap.ts',
  'src/commands/cost/daemon.ts',
  'src/commands/cost/index.ts',
  'scripts/nodes/close/task-close.ts',
  'scripts/ladder/expect-sample.ts',
  'tests/daemon.test.ts',
]
const NAMES_THE_CLAUDE_MODULE = /['"][^'"]*\/claude-code\.js['"]/
const CLAUDE_ENV = { CLAUDECODE: '1' }
const CURSOR_ENV = { CURSOR_AGENT: '1' }
const RUN = 'wf_registry'
const AGENT = 'daemon:one:alpha'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function aRoot(): string {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'client-cost-')))
  roots.push(root)
  return root
}

function assistantLine(requestId: string, input: number, cacheRead: number, output: number): string {
  return `${JSON.stringify({ requestId, timestamp: '2026-11-05T00:00:00.000Z', message: { role: 'assistant', model: 'sonnet', usage: { input_tokens: input, cache_read_input_tokens: cacheRead, output_tokens: output } } })}\n`
}

function recordedSession(projects: string, cwd: string): void {
  const run = path.join(projects, projectKey(cwd), 'session-1', 'subagents', 'workflows', RUN)
  mkdirSync(run, { recursive: true })
  writeFileSync(path.join(run, 'agent-1.jsonl'), assistantLine('r1', 100, 400, 50))
  writeFileSync(path.join(run, 'agent-1.meta.json'), JSON.stringify({ description: AGENT, agentType: 'implementer' }))
}

function daemonEvidence(cwd: string, object: string, agent: string | null): void {
  const home = path.join(cwd, '.construct', 'daemon', 'one', object)
  mkdirSync(home, { recursive: true })
  writeFileSync(path.join(home, 'evidence.json'), JSON.stringify({ verdict: 'pass', agent }))
}

function emptyRoots(root: string): { shiftRoot: string, busPath: string } {
  return { shiftRoot: path.join(root, 'shift'), busPath: path.join(root, 'bus.db') }
}

it('only the registry imports claude-code.js', () => {
  const importers = [...CLOSED_BYPASSES, REGISTRY].filter(file => NAMES_THE_CLAUDE_MODULE.test(readFileSync(path.join(REPO_ROOT, file), 'utf8')))
  expect(importers).toEqual([REGISTRY])
})

it('construct cost gives the same report through the registry', () => {
  const root = aRoot()
  const projects = path.join(root, 'projects')
  const cwd = path.join(root, 'repo')
  mkdirSync(cwd)
  recordedSession(projects, cwd)
  daemonEvidence(cwd, 'alpha', AGENT)
  daemonEvidence(cwd, 'beta', 'daemon:one:absent')
  daemonEvidence(cwd, 'gamma', null)

  const report = costReport(cwd, { ...emptyRoots(root), projectsDir: projects, env: CLAUDE_ENV, version: '0' })

  expect(report.status).toBe('ok')
  expect(report.runs?.map(run => [run.run, run.agents.map(agent => [agent.label, agent.type]), run.total])).toEqual([
    [RUN, [[AGENT, 'implementer']], { calls: 1, input: 100, cacheWrite: 0, cacheRead: 400, output: 50, models: ['sonnet'] }],
  ])
  expect(report.daemon).toEqual([
    { run: 'one', object: 'alpha', verdict: 'pass', agent: AGENT, tokens: 150 },
    { run: 'one', object: 'beta', verdict: 'pass', agent: 'daemon:one:absent', tokens: null },
    { run: 'one', object: 'gamma', verdict: 'pass', agent: null, tokens: null },
  ])
  expect(readDaemonObjects(cwd, projects)).toEqual(report.daemon)
  expect(sessionTokens(projects, { id: 'absent', project: projectKey(cwd) })).toBeNull()

  const source = costSourceFor('claude-code', projects)
  expect(source?.runtime).toBe('claude-code')
  expect(source?.read(cwd, [])).toMatchObject({ status: 'ok', key: projectKey(cwd), candidates: [], runs: report.runs })
  expect(recordingSource(projects).steps(RUN)).toEqual(source?.steps(RUN))
  expect(costJson(report, false)).toMatchObject({ status: 'ok', runtime: 'claude-code', key: projectKey(cwd) })
})

it('a runtime the registry holds no source for reads as unsupported, as before', () => {
  const root = aRoot()
  const projects = path.join(root, 'projects')
  const cwd = path.join(root, 'repo')
  mkdirSync(cwd)
  recordedSession(projects, cwd)

  expect(costSourceFor('cursor', projects)).toBeNull()
  expect(costReport(cwd, { ...emptyRoots(root), projectsDir: projects, env: CURSOR_ENV, version: '0' })).toMatchObject({ status: 'unsupported', runtime: 'cursor' })
})
