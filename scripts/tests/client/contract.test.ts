import type { LadderSteps } from '../../ladder/ladder-starter.js'
import type { DetachedSpawn, StarterPorts } from '../../nodes/launch/launch-starter.js'
import type { Invocation, Refusal, Role, SessionJournal, SessionPolicy, SessionSpec } from '../../ports/client/contract.js'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, expect, it } from 'vitest'
import { parkingFileText } from '../../../src/card/parking.js'
import { appendEvent, openBus } from '../../core/db.js'
import { LadderCardStarter } from '../../ladder/ladder-starter.js'
import { cardCommand, launchArgv, shellWord } from '../../nodes/launch/launch-starter.js'
import { parseSessionJournal } from '../../nodes/launch/session-journal.js'
import { claudeResume } from '../../nodes/launch/tree-pr-cli.js'
import { WINDOW_RESUME_REFUSAL } from '../../ports/client/claude/adapter.js'
import { clientAdapter } from '../../ports/client/index.js'
import { sessionEnv, witnessEnv } from '../../ports/session.js'
import { settingsFlag, shiftSettings } from '../../ports/shift-settings.js'
import { claudeArgv, DEFAULT_CLAUDE } from '../../window/loop.js'

const SESSION = 'sess-1573'
const PROMPT = 'do the card'
const ADD_DIR = '/reviews'
const MODEL = 'the-review-model'
const GATE = 'pnpm run gate'
const QUESTION = '/owner/question.md'
const CARD = 1573
const CARD_FLAGS = ['--permission-mode', 'dontAsk']
const HEADLESS_FLAGS = ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'auto', '--permission-prompts', 'none', '--strict-mcp-config']
const CARD_TOOLS = ['--tools', 'Read,Edit,Write,Bash,Grep,Glob', '--disable-slash-commands']
const USER_INSTRUCTIONS_OFF = { autoMemoryEnabled: false, claudeMdExcludes: [path.join(homedir(), '.claude', 'CLAUDE.md')] }
const REVIEW_SETTINGS = ['--settings', JSON.stringify(USER_INSTRUCTIONS_OFF)]

const CLIENT_DEFAULT: SessionPolicy = { profile: 'client-default', gateCommands: [], writePaths: [], mcpOff: false }
const HEADLESS: SessionPolicy = { ...CLIENT_DEFAULT, mcpOff: true }

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

interface Spot {
  root: string
  stub: string
  stubPath: string
  seen: () => Captured
}

interface Captured {
  args: string[]
  stdin: string
}

function aSpot(): Spot {
  const root = mkdtempSync(path.join(tmpdir(), 'client-contract-'))
  roots.push(root)
  const stub = path.join(root, 'claude')
  const argv = path.join(root, 'argv')
  const input = path.join(root, 'stdin')
  writeFileSync(stub, `#!/bin/sh\nprintf '%s\\0' "$@" > '${argv}'\ncat > '${input}'\n`)
  chmodSync(stub, 0o755)
  writeFileSync(path.join(root, 'construct.json'), `${JSON.stringify({ harness: { command: GATE }, shift: { prepush: [GATE] } })}\n`)
  return {
    root,
    stub,
    stubPath: `${root}:${process.env.PATH}`,
    seen: () => ({ args: readFileSync(argv, 'utf8').split('\0').slice(0, -1), stdin: readFileSync(input, 'utf8') }),
  }
}

function throughShell(spot: Spot, args: readonly string[], input: string): Captured {
  const run = spawnSync('sh', args, { cwd: spot.root, input, env: { ...process.env, PATH: spot.stubPath } })
  expect(run.status, String(run.stderr)).toBe(0)
  return spot.seen()
}

function gatedSettings(spot: Spot, writable: string[] = []): string[] {
  return settingsFlag(shiftSettings(spot.root, { prepush: [GATE], handoffWrite: null, codeMatrix: null }, writable))
}

function cardSettings(spot: Spot, writable: string[] = []): string[] {
  return settingsFlag({ ...shiftSettings(spot.root, { prepush: [GATE], handoffWrite: null, codeMatrix: null }, writable), ...USER_INSTRUCTIONS_OFF })
}

function launchStartToday(spot: Spot): Captured {
  const command = [cardCommand('claude'), ...cardSettings(spot).map(shellWord), ...CARD_TOOLS].join(' ')
  const args = launchArgv({ command, treePr: 'true', cardId: CARD, worktree: spot.root, report: path.join(spot.root, 'report'), exit: path.join(spot.root, 'exit'), id: SESSION })
  return throughShell(spot, args, PROMPT)
}

function ladderStartToday(spot: Spot): Captured {
  const spawned: DetachedSpawn[] = []
  const body = parkingFileText({ card: `#${CARD} a-card [implement/construct/S/ladder/auto] · depends — · blocks —`, branch: 'feat/a-card', touches: ['scripts/x.ts'], continue: 'stop', who: 'shift', body: 'unused' })
  const ports = {
    read: () => body,
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
  const steps: LadderSteps = {
    stepOf: () => ({ kind: 'review' }),
    tree: () => spot.root,
    brief: () => '/unused',
    tasksFile: () => '/unused',
    body: () => 'unused',
  }
  new LadderCardStarter({ launchDir: path.join(spot.root, 'launch'), claude: 'claude', treePr: 'true', repo: spot.root }, ports, steps).start({ cardId: CARD, lane: 'lane-x' })
  return throughShell(spot, spawned[0]!.args, spawned[0]!.input)
}

function cardResumeToday(spot: Spot): Captured {
  const busPath = path.join(spot.root, 'bus.db')
  const db = openBus(busPath)
  appendEvent(db, { ts: '2026-11-05T00:00:00.000Z', type: 'card.started', actor: 'worker:launch:1', cardId: CARD, pr: null, head: null, dedupeKey: `start:${CARD}`, payload: { session: SESSION, worktree: spot.root, branch: 'feat/a-card' }, legacy: false })
  db.close()
  expect(claudeResume(busPath, spot.stub, 10_000)(CARD, spot.root, PROMPT)).toBe(true)
  return spot.seen()
}

function windowStartToday(spot: Spot, prompt: string | undefined): Captured {
  return throughShell(spot, claudeArgv(DEFAULT_CLAUDE, prompt), '')
}

interface Golden {
  label: string
  role: Role
  kind: SessionSpec['kind']
  spec?: (spot: Spot) => Partial<SessionSpec>
  today: (spot: Spot) => Captured
  literal: (spot: Spot) => string[]
  stdin: string | null
}

const GATED = (spot: Spot): Partial<SessionSpec> => ({ policy: { profile: 'sandboxed', gateCommands: [GATE], writePaths: [], mcpOff: true }, cwd: spot.root })
const ANSWERING = (spot: Spot): Partial<SessionSpec> => ({ policy: { profile: 'sandboxed', gateCommands: [GATE], writePaths: [QUESTION], mcpOff: true }, cwd: spot.root, addDirs: [ADD_DIR] })

const GOLDENS: Golden[] = [
  {
    label: 'review start with no model',
    role: 'review',
    kind: 'start',
    spec: () => ({ addDirs: [ADD_DIR], policy: HEADLESS }),
    today: () => ({ args: [...REVIEW_SETTINGS, '--add-dir', ADD_DIR, ...CARD_TOOLS, ...HEADLESS_FLAGS, '--session-id', SESSION, PROMPT], stdin: '' }),
    literal: () => [...REVIEW_SETTINGS, '--add-dir', ADD_DIR, ...CARD_TOOLS, ...HEADLESS_FLAGS, '--session-id', SESSION, PROMPT],
    stdin: null,
  },
  {
    label: 'review start with its model',
    role: 'review',
    kind: 'start',
    spec: () => ({ addDirs: [ADD_DIR], pick: { model: MODEL }, policy: HEADLESS }),
    today: () => ({ args: [...REVIEW_SETTINGS, '--add-dir', ADD_DIR, '--model', MODEL, ...CARD_TOOLS, ...HEADLESS_FLAGS, '--session-id', SESSION, PROMPT], stdin: '' }),
    literal: () => [...REVIEW_SETTINGS, '--add-dir', ADD_DIR, '--model', MODEL, ...CARD_TOOLS, ...HEADLESS_FLAGS, '--session-id', SESSION, PROMPT],
    stdin: null,
  },
  {
    label: 'review resume',
    role: 'review',
    kind: 'resume',
    spec: () => ({ addDirs: [ADD_DIR], policy: HEADLESS }),
    today: () => ({ args: [...REVIEW_SETTINGS, '--add-dir', ADD_DIR, ...CARD_TOOLS, ...HEADLESS_FLAGS, '--resume', SESSION, PROMPT], stdin: '' }),
    literal: () => [...REVIEW_SETTINGS, '--add-dir', ADD_DIR, ...CARD_TOOLS, ...HEADLESS_FLAGS, '--resume', SESSION, PROMPT],
    stdin: null,
  },
  {
    label: 'answer start',
    role: 'answer',
    kind: 'start',
    spec: ANSWERING,
    today: spot => ({ args: [...cardSettings(spot, [QUESTION]), '--add-dir', ADD_DIR, ...CARD_TOOLS, ...HEADLESS_FLAGS, '--session-id', SESSION, PROMPT], stdin: '' }),
    literal: spot => [...cardSettings(spot, [QUESTION]), '--add-dir', ADD_DIR, ...CARD_TOOLS, ...HEADLESS_FLAGS, '--session-id', SESSION, PROMPT],
    stdin: null,
  },
  {
    label: 'answer resume',
    role: 'answer',
    kind: 'resume',
    spec: ANSWERING,
    today: spot => ({ args: [...cardSettings(spot, [QUESTION]), '--add-dir', ADD_DIR, ...CARD_TOOLS, ...HEADLESS_FLAGS, '--resume', SESSION, PROMPT], stdin: '' }),
    literal: spot => [...cardSettings(spot, [QUESTION]), '--add-dir', ADD_DIR, ...CARD_TOOLS, ...HEADLESS_FLAGS, '--resume', SESSION, PROMPT],
    stdin: null,
  },
  {
    label: 'launch start',
    role: 'launch',
    kind: 'start',
    spec: GATED,
    today: launchStartToday,
    literal: spot => [...CARD_FLAGS, ...cardSettings(spot), ...CARD_TOOLS, '--strict-mcp-config', '-p', '--session-id', SESSION],
    stdin: PROMPT,
  },
  {
    label: 'launch resume',
    role: 'launch',
    kind: 'resume',
    spec: GATED,
    today: cardResumeToday,
    literal: spot => [...CARD_FLAGS, ...cardSettings(spot), ...CARD_TOOLS, '--strict-mcp-config', '-p', '--resume', SESSION, PROMPT],
    stdin: null,
  },
  {
    label: 'ladder start',
    role: 'ladder',
    kind: 'start',
    spec: spot => ({ policy: CLIENT_DEFAULT, cwd: spot.root }),
    today: ladderStartToday,
    literal: () => [...CARD_FLAGS, '-p', '--session-id', SESSION],
    stdin: PROMPT,
  },
  {
    label: 'ladder resume',
    role: 'ladder',
    kind: 'resume',
    spec: GATED,
    today: spot => ({ args: [...CARD_FLAGS, ...gatedSettings(spot), '--strict-mcp-config', '-p', '--resume', SESSION, PROMPT], stdin: '' }),
    literal: spot => [...CARD_FLAGS, ...gatedSettings(spot), '--strict-mcp-config', '-p', '--resume', SESSION, PROMPT],
    stdin: null,
  },
  {
    label: 'window start with a prompt',
    role: 'window',
    kind: 'start',
    spec: () => ({ policy: CLIENT_DEFAULT }),
    today: spot => windowStartToday(spot, PROMPT),
    literal: () => [...CARD_FLAGS, PROMPT],
    stdin: null,
  },
  {
    label: 'window start with no prompt',
    role: 'window',
    kind: 'start',
    spec: () => ({ policy: CLIENT_DEFAULT, prompt: '' }),
    today: spot => windowStartToday(spot, undefined),
    literal: () => CARD_FLAGS,
    stdin: null,
  },
]

function specOf(golden: Golden, spot: Spot): SessionSpec {
  return { kind: golden.kind, role: golden.role, session: SESSION, cwd: spot.root, prompt: PROMPT, addDirs: [], pick: { model: null }, policy: CLIENT_DEFAULT, ...golden.spec?.(spot) }
}

function invoked(spec: SessionSpec): Invocation {
  const result = clientAdapter().invocation(spec)
  if ('kind' in result)
    throw new Error(`refused: ${result.reason}`)
  return result
}

it('the invocation of each role equals the argv of the existing code byte for byte', () => {
  const kindsOfRole = new Set(GOLDENS.map(golden => `${golden.role}:${golden.kind}`))
  expect(kindsOfRole).toEqual(new Set(['review:start', 'review:resume', 'answer:start', 'answer:resume', 'launch:start', 'launch:resume', 'ladder:start', 'ladder:resume', 'window:start']))
  for (const golden of GOLDENS) {
    const spot = aSpot()
    const invocation = invoked(specOf(golden, spot))
    const today = golden.today(spot)
    expect(invocation.command, golden.label).toBe('claude')
    expect(invocation.args, golden.label).toEqual(today.args)
    expect(invocation.args, golden.label).toEqual(golden.literal(spot))
    expect(invocation.stdin, golden.label).toBe(golden.stdin)
    expect(invocation.stdin ?? '', golden.label).toBe(today.stdin)
  }
})

it('a window resume is refused by name, because no existing code resumes a window', () => {
  const spot = aSpot()
  const refusal = clientAdapter().invocation(specOf({ label: 'window resume', role: 'window', kind: 'resume', today: spot.seen, literal: () => [], stdin: null }, spot)) as Refusal
  expect(refusal).toEqual({ kind: 'refused', reason: WINDOW_RESUME_REFUSAL })
})

it('the env of an invocation is what sessionEnv adds to the core environment, and a window adds nothing', () => {
  const base: NodeJS.ProcessEnv = { PATH: '/bin', FORCE_COLOR: '1' }
  for (const golden of GOLDENS) {
    const invocation = invoked(specOf(golden, aSpot()))
    if (golden.role === 'window')
      expect(invocation.env, golden.label).toEqual({})
    else
      expect({ ...witnessEnv(base), ...invocation.env }, golden.label).toEqual(sessionEnv(base))
  }
})

it('the journal of the contract is the shape the session journal parser returns', () => {
  const parse: (text: string, worktree: string) => SessionJournal = parseSessionJournal
  const entry = JSON.stringify({ timestamp: '2026-11-05T00:00:00.000Z' })
  expect(parse(entry, '/tree').changes.size).toBe(0)
})

it('clientAdapter returns Claude and its capabilities', () => {
  const adapter = clientAdapter()
  expect(adapter.id).toBe('claude')
  expect(adapter.capabilities).toEqual({ identity: 'assigned', ladder: true, reports: { cost: true, turns: true, model: true, denials: true, journal: true }, guarantees: { allowlist: true, writeConfinement: true, mcpOff: true, toolNarrowing: true, guardFailsClosed: true } })
})
