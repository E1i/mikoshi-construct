import type { LadderSteps } from '../../ladder/ladder-starter.js'
import type { AnswerRun } from '../../nodes/answer/answerer.js'
import type { DetachedSpawn, StarterPorts } from '../../nodes/launch/launch-starter.js'
import type { ClientAdapter, SessionSpec } from '../../ports/client/contract.js'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { parkingFileText } from '../../../src/card/parking.js'
import { appendEvent, openBus } from '../../core/db.js'
import { exitCodePath } from '../../core/places.js'
import { LadderCardStarter } from '../../ladder/ladder-starter.js'
import { claudeAnswerer, ownerQuestionPath, realAnswererTools } from '../../nodes/answer/answerer.js'
import { cardCommand, launchArgv, shellWord, ShiftCardStarter } from '../../nodes/launch/launch-starter.js'
import { claudeResume } from '../../nodes/launch/tree-pr-cli.js'
import { WINDOW_RESUME_REFUSAL } from '../../ports/client/claude/adapter.js'
import { clientInvocation, sessionEnv, spawnReviewSession } from '../../ports/session.js'
import { settingsFlag, shiftSettings } from '../../ports/shift-settings.js'

const client = vi.hoisted(() => ({ binary: '', specs: [] as SessionSpec[] }))

vi.mock('../../ports/client/index.js', async () => {
  const actual = await vi.importActual<{ claudeAdapter: ClientAdapter }>('../../ports/client/claude/adapter.js')
  return {
    clientAdapter: (): ClientAdapter => ({
      ...actual.claudeAdapter,
      invocation: (spec) => {
        client.specs.push(spec)
        const result = actual.claudeAdapter.invocation(spec)
        return 'kind' in result ? result : { ...result, command: client.binary, env: { ...result.env, CLIENT_MARK: 'from-the-adapter' } }
      },
    }),
  }
})

const SESSION = 'sess-1574'
const PROMPT = 'do the card'
const ADD_DIR = '/reviews'
const MODEL = 'the-review-model'
const GATE = 'pnpm run gate'
const CARD = 1574
const CARD_FLAGS = ['--permission-mode', 'dontAsk']
const HEADLESS_FLAGS = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'auto', '--permission-prompts', 'none', '--strict-mcp-config']
const CARD_TOOLS = ['--tools', 'Read,Edit,Write,Bash,Grep,Glob', '--disable-slash-commands']
const USER_INSTRUCTIONS_OFF = { autoMemoryEnabled: false, claudeMdExcludes: [path.join(homedir(), '.claude', 'CLAUDE.md')] }
const CARD_LINE = `#${CARD} a-card [implement/construct/S/ladder/auto] · depends — · blocks —`

interface Spot {
  root: string
  stub: string
  seen: () => Captured
}

interface Captured {
  args: string[]
  stdin: string
  mark: string
}

interface Spawned {
  specs: string[]
  args: string[]
  stdin: string
}

const roots: string[] = []

beforeEach(() => {
  client.specs.length = 0
})

afterEach(() => {
  vi.unstubAllEnvs()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function executable(file: string, text: string): void {
  writeFileSync(file, text)
  chmodSync(file, 0o755)
}

function aSpot(): Spot {
  const root = mkdtempSync(path.join(tmpdir(), 'client-spawn-'))
  roots.push(root)
  const stub = path.join(root, 'recording-client')
  const [argv, input, mark] = ['argv', 'stdin', 'mark'].map(name => path.join(root, name)) as [string, string, string]
  executable(stub, `#!/bin/sh\nprintf '%s\\0' "$@" > '${argv}'\ncat > '${input}'\nprintf '%s' "$CLIENT_MARK" > '${mark}'\n`)
  const decoys = path.join(root, 'decoys')
  mkdirSync(decoys)
  executable(path.join(decoys, 'claude'), '#!/bin/sh\nexit 0\n')
  vi.stubEnv('PATH', `${decoys}${path.delimiter}${process.env.PATH}`)
  writeFileSync(path.join(root, 'construct.json'), `${JSON.stringify({ harness: { command: GATE }, shift: { prepush: [GATE] } })}\n`)
  client.binary = stub
  return {
    root,
    stub,
    seen: () => ({ args: readFileSync(argv, 'utf8').split('\0').slice(0, -1), stdin: readFileSync(input, 'utf8'), mark: readFileSync(mark, 'utf8') }),
  }
}

function cardSettings(spot: Spot, writable: string[] = []): string[] {
  return settingsFlag({ ...shiftSettings(spot.root, { prepush: [GATE], handoffWrite: null, codeMatrix: null }, writable), ...USER_INSTRUCTIONS_OFF })
}

function startedSpecs(): string[] {
  return client.specs.filter(spec => spec.session === SESSION).map(spec => `${spec.role}:${spec.kind}`)
}

function throughShell(spot: Spot, run: DetachedSpawn): void {
  const ran = spawnSync('sh', run.args, { cwd: spot.root, input: run.input, env: { ...process.env, ...run.env } })
  expect(ran.status, String(ran.stderr)).toBe(0)
}

function starterPorts(spot: Spot, spawned: DetachedSpawn[]): StarterPorts {
  const body = parkingFileText({ card: CARD_LINE, branch: 'feat/a-card', touches: ['scripts/x.ts'], continue: 'stop', who: 'shift', body: 'unused' })
  return {
    read: () => body,
    cut: () => spot.root,
    base: () => 'b'.repeat(40),
    spawnDetached: (run: DetachedSpawn) => {
      spawned.push(run)
      return 1
    },
    pgidOf: () => 1,
    uuid: () => SESSION,
    envOf: () => ({}),
    prompt: () => PROMPT,
  } as unknown as StarterPorts
}

async function review(spot: Spot): Promise<Spawned> {
  const code = await spawnReviewSession({ cwd: spot.root, sessionId: SESSION, prompt: PROMPT, stdoutPath: path.join(spot.root, 'out'), stderrPath: path.join(spot.root, 'err'), addDirs: [ADD_DIR], model: MODEL })
  expect(code).toBe(0)
  return { specs: startedSpecs(), args: ['--settings', JSON.stringify(USER_INSTRUCTIONS_OFF), '--add-dir', ADD_DIR, '--model', MODEL, ...CARD_TOOLS, ...HEADLESS_FLAGS, '--session-id', SESSION, PROMPT], stdin: '' }
}

function answerOf(kind: 'start' | 'resume'): (spot: Spot) => Promise<Spawned> {
  return async (spot) => {
    const dir = path.join(spot.root, 'answers')
    const runs: AnswerRun[] = []
    const spawnReally = realAnswererTools(path.join(spot.root, 'bus.db')).spawn
    const answerer = claudeAnswerer(dir, {
      cardText: () => 'the card',
      available: () => kind === 'resume',
      remoteHead: () => null,
      newSession: () => SESSION,
      publish: () => {},
      spawn: (run) => {
        runs.push(run)
        return spawnReally(run)
      },
    })
    const lease = { taskKey: `answer:${CARD}:1`, queue: 'answer' as const, cardId: CARD, pr: 1, head: 'a'.repeat(40), leaseGen: 1, actor: 'worker:answer:1' }
    await answerer({ lease, source: { kind: 'changes', findings: [], events: [], decisions: [] }, widened: null, card: { session: SESSION, worktree: spot.root, branch: 'feat/a-card' } })
    const question = ownerQuestionPath(dir, SESSION, lease.leaseGen)
    const identity = kind === 'start' ? '--session-id' : '--resume'
    expect(runs[0]!.command).toBe(spot.stub)
    return { specs: startedSpecs(), args: [...cardSettings(spot, [question]), '--add-dir', dir, ...CARD_TOOLS, ...HEADLESS_FLAGS, identity, SESSION, runs[0]!.argv.at(-1)!], stdin: '' }
  }
}

async function launch(spot: Spot): Promise<Spawned> {
  const spawned: DetachedSpawn[] = []
  const launchDir = path.join(spot.root, 'launch')
  mkdirSync(launchDir)
  expect(new ShiftCardStarter({ launchDir, treePr: 'true' }, starterPorts(spot, spawned)).start({ cardId: CARD, lane: 'lane-x' }).kind).toBe('started')
  expect(spawned[0]!.args).toEqual(launchArgv({ command: [cardCommand(spot.stub), ...[...cardSettings(spot), ...CARD_TOOLS].map(shellWord)].join(' '), treePr: 'true', cardId: CARD, worktree: spot.root, report: path.join(launchDir, `report-${CARD}.md`), exit: exitCodePath(launchDir, String(CARD)), id: SESSION }))
  throughShell(spot, spawned[0]!)
  return { specs: startedSpecs(), args: [...CARD_FLAGS, ...cardSettings(spot), ...CARD_TOOLS, '--strict-mcp-config', '-p', '--session-id', SESSION], stdin: PROMPT }
}

async function ladder(spot: Spot): Promise<Spawned> {
  const spawned: DetachedSpawn[] = []
  const steps: LadderSteps = {
    stepOf: () => ({ kind: 'review' }),
    tree: () => spot.root,
    brief: () => '/unused',
    tasksFile: () => '/unused',
    body: () => 'unused',
  }
  expect(new LadderCardStarter({ launchDir: path.join(spot.root, 'launch'), treePr: 'true', repo: spot.root }, starterPorts(spot, spawned), steps).start({ cardId: CARD, lane: 'lane-x' }).kind).toBe('started')
  expect(spawned[0]!.args.slice(2)).toEqual(['shift', '-p', '--session-id', SESSION])
  expect(spawned[0]!.args[1]).toContain(`env ${spot.stub} --permission-mode dontAsk "$@" && true`)
  throughShell(spot, spawned[0]!)
  return { specs: startedSpecs(), args: [...CARD_FLAGS, '-p', '--session-id', SESSION], stdin: PROMPT }
}

async function resume(spot: Spot): Promise<Spawned> {
  const busPath = path.join(spot.root, 'bus.db')
  const db = openBus(busPath)
  appendEvent(db, { ts: '2026-11-05T00:00:00.000Z', type: 'card.started', actor: 'worker:launch:1', cardId: CARD, pr: null, head: null, dedupeKey: `start:${CARD}`, payload: { session: SESSION, worktree: spot.root, branch: 'feat/a-card' }, legacy: false })
  db.close()
  expect(claudeResume(busPath)(CARD, spot.root, PROMPT)).toBe(true)
  return { specs: startedSpecs(), args: [...CARD_FLAGS, ...cardSettings(spot), ...CARD_TOOLS, '--strict-mcp-config', '-p', '--resume', SESSION, PROMPT], stdin: '' }
}

const SPAWN_POINTS: { label: string, spec: string, run: (spot: Spot) => Promise<Spawned> }[] = [
  { label: 'review', spec: 'review:start', run: review },
  { label: 'answer start', spec: 'answer:start', run: answerOf('start') },
  { label: 'answer resume', spec: 'answer:resume', run: answerOf('resume') },
  { label: 'launch', spec: 'launch:start', run: launch },
  { label: 'ladder', spec: 'ladder:start', run: ladder },
  { label: 'held-tree resume', spec: 'launch:resume', run: resume },
]

it('every spawn point takes the golden argv from the adapter', async () => {
  for (const point of SPAWN_POINTS) {
    client.specs.length = 0
    const spot = aSpot()
    const spawned = await point.run(spot)
    const seen = spot.seen()
    expect(spawned.specs, point.label).toEqual([point.spec])
    expect(seen.args, point.label).toEqual(spawned.args)
    expect(seen.stdin, point.label).toBe(spawned.stdin)
    expect(seen.mark, point.label).toBe('from-the-adapter')
    vi.unstubAllEnvs()
  }
})

const SPAWN_FILES = ['ports/session.ts', 'nodes/answer/answerer.ts', 'nodes/launch/launch-root.ts', 'nodes/launch/tree-pr-cli.ts']

it('the client binary literal is gone from the spawn files', () => {
  for (const file of SPAWN_FILES) {
    const source = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8')
    expect(source, file).not.toContain(`'claude'`)
    expect(source, file).not.toContain('CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS')
  }
})

it('the env of a session carries what the adapter asks for', () => {
  aSpot()
  expect(sessionEnv({ PATH: '/bin' })).toEqual({ PATH: '/bin', NO_COLOR: '1', CLIENT_MARK: 'from-the-adapter', CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: '0' })
})

it('a refused invocation throws the reason of the adapter and spawns nothing', () => {
  const spot = aSpot()
  expect(() => clientInvocation({ kind: 'resume', role: 'window', session: SESSION, cwd: spot.root, prompt: PROMPT, addDirs: [], pick: { model: null }, policy: { profile: 'client-default', gateCommands: [], writePaths: [], mcpOff: false } })).toThrow(WINDOW_RESUME_REFUSAL)
  expect(existsSync(path.join(spot.root, 'argv'))).toBe(false)
})
