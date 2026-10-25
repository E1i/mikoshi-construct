import type { CardStart, StartedCard } from '../../nodes/launch/launch-executor.js'
import type { StarterPorts } from '../../nodes/launch/launch-starter.js'
import type { TreeFile } from '../../nodes/launch/session-journal.js'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { devNull, tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parkingFileText } from '../../../src/card/parking.js'
import { appendEvent, openBus } from '../../core/db.js'
import { HTTPS_ORIGIN_ENV, launchArgv, launchEnv, ShiftCardStarter } from '../../nodes/launch/launch-starter.js'
import { busCardSessions } from '../../nodes/launch/launch-worker.js'
import { BUS_DB_VARIABLE } from '../../core/bus-path.js'
import { CARD_ANSWERED, CARD_STARTED, CARD_STOPPED } from '../../core/events.js'

const NO_FILE_CONFIG_ENV = { GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: '1' }

function gitConfig(args: string[]): string {
  const { GIT_DIR: _gitDir, GIT_WORK_TREE: _workTree, ...outsideAnyRepository } = process.env
  return execFileSync('git', ['config', ...args], { encoding: 'utf8', cwd: tmpdir(), env: { ...outsideAnyRepository, ...NO_FILE_CONFIG_ENV, ...HTTPS_ORIGIN_ENV } }).replace(/\n$/, '')
}

describe('the launch env', () => {
  it('the launch env gives git a credential helper for https://github.com', () => {
    expect(gitConfig(['--get-urlmatch', 'credential.helper', 'https://github.com/E1i/mikoshi-construct.git'])).toBe('!gh auth git-credential')
    expect(gitConfig(['--get-all', 'credential.https://github.com.helper']).split('\n')).toEqual(['', '!gh auth git-credential'])
  })

  it('the launch env rewrites both ssh forms of a github origin to https', () => {
    expect(gitConfig(['--get-all', 'url.https://github.com/.insteadOf']).split('\n')).toEqual(['git@github.com:', 'ssh://git@github.com/'])
  })
})

const CARD = 1248
const TREE = '/trees/mc-1248'
const SESSION = 'sess-ended'
const LAUNCH_DIR = '/launch'
const MINUTE = 60_000
const T0 = Date.parse('2026-10-22T10:00:00.000Z')

function at(minutes: number): number {
  return T0 + minutes * MINUTE
}

function stamp(minutes: number): string {
  return new Date(at(minutes)).toISOString()
}

let toolIds = 0

function toolCall(minutes: number, name: string, input: Record<string, unknown>): string[] {
  const id = `toolu_${++toolIds}`
  return [
    JSON.stringify({ type: 'assistant', timestamp: stamp(minutes), message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } }),
    JSON.stringify({ type: 'user', timestamp: stamp(minutes), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } }),
  ]
}

function transcript(...calls: string[][]): string {
  return [...calls.flat(), JSON.stringify({ type: 'system', timestamp: stamp(30) })].join('\n')
}

const SESSION_JOURNAL = transcript(
  toolCall(1, 'Write', { file_path: `${TREE}/src/written.ts`, content: 'one\ntwo\n' }),
  toolCall(2, 'Edit', { file_path: `${TREE}/src/written.ts`, old_string: 'two', new_string: 'three', replace_all: false }),
  toolCall(3, 'Edit', { file_path: `${TREE}/src/edited.ts`, old_string: 'old', new_string: 'the session line', replace_all: false }),
  toolCall(4, 'Edit', { file_path: `${TREE}/src/late.ts`, old_string: 'old', new_string: 'late line', replace_all: false }),
  toolCall(5, 'Edit', { file_path: `${TREE}/src/shelled.ts`, old_string: 'old', new_string: 'shelled line', replace_all: false }),
  toolCall(6, 'Bash', { command: 'python3 rewrite.py src/shelled.ts' }),
)

const TREE_FILES: Record<string, TreeFile> = {
  'src/written.ts': { content: 'one\nthree\n', mtimeMs: at(2) },
  'src/edited.ts': { content: 'head\nthe session line\ntail\n', mtimeMs: at(3) },
  'src/late.ts': { content: 'late line\n', mtimeMs: at(45) },
  'src/shelled.ts': { content: 'shelled line\nand more\n', mtimeMs: at(6) },
  'src/foreign.ts': { content: 'nobody here wrote this\n', mtimeMs: at(2) },
  'src/earlier.ts': { content: 'earlier\n', mtimeMs: at(1) },
}

const EARLIER = 'sess-earlier'

const EARLIER_JOURNAL = transcript(
  toolCall(1, 'Write', { file_path: `${TREE}/src/earlier.ts`, content: 'earlier\n' }),
)

const earlierSession: Partial<StarterPorts> = {
  cardSessions: () => [EARLIER, SESSION],
  readTranscript: (worktree, session) => worktree !== TREE ? null : session === EARLIER ? EARLIER_JOURNAL : session === SESSION ? SESSION_JOURNAL : null,
}

const CARD_TEXT = parkingFileText({ card: `#${CARD} card-${CARD} [implement/netwatch/S/cheap/auto] · depends — · blocks —`, branch: `feat/card-${CARD}`, touches: ['src/**'], continue: 'auto', who: 'shift', body: 'Do the card.' })

function heldTree(changed: string[], overrides: Partial<StarterPorts> = {}): { start: () => CardStart, startQueued: () => CardStart, spawned: string[] } {
  const spawned: string[] = []
  const ports: StarterPorts = {
    read: cardId => cardId === CARD ? CARD_TEXT : null,
    cut: () => {
      throw new Error('a held tree is never cut')
    },
    base: () => 'b'.repeat(40),
    spawnDetached: (run) => {
      spawned.push(run.cwd)
      return 4242
    },
    pgidOf: pid => pid,
    kill: () => {},
    uuid: () => 'sess-next',
    envOf: () => ({}),
    prompt: task => task.body,
    changedPaths: () => changed,
    readReport: file => file === path.join(LAUNCH_DIR, `report-${CARD}.md`) ? 'result: stopped at a boundary\nnotes.md holds the plan\n' : null,
    cardSessions: () => [SESSION],
    readTranscript: (worktree, session) => worktree === TREE && session === SESSION ? SESSION_JOURNAL : null,
    treeFile: file => TREE_FILES[path.relative(TREE, file)] ?? null,
    ...overrides,
  }
  const starter = new ShiftCardStarter({ launchDir: LAUNCH_DIR, claude: 'claude', treePr: 'true' }, ports)
  const from: StartedCard = { session: SESSION, worktree: TREE, branch: `feat/card-${CARD}`, base: 'a'.repeat(40), pid: 1, pgid: 1, contour: 'cheap' }
  return {
    start: () => starter.continueFrom({ cardId: CARD, lane: 'lane-1' }, from),
    startQueued: () => starter.start({ cardId: CARD, lane: 'lane-1', continueIn: { worktree: TREE, base: null } }),
    spawned,
  }
}

function refusedPaths(outcome: CardStart): string[] | undefined {
  return outcome.kind === 'refused' ? outcome.denial.paths : undefined
}

describe('the bus of a launch', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  const LAUNCHING_BUS = path.join(tmpdir(), 'launching-bus', 'bus.db')

  it('the claude command of a launch runs without CONSTRUCT_BUS_DB, and tree-pr after it with the launching bus', () => {
    const probe = (name: string): string => `sh -c 'echo "${name}=\${${BUS_DB_VARIABLE}:-unset}"' ${name}`
    const args = launchArgv({ command: probe('claude'), treePr: probe('treepr'), cardId: CARD, worktree: TREE, report: '/r', id: SESSION })
    const run = spawnSync('sh', args, { encoding: 'utf8', env: { ...process.env, [BUS_DB_VARIABLE]: LAUNCHING_BUS } })
    expect(run.stdout.split('\n')).toEqual(['claude=unset', `treepr=${LAUNCHING_BUS}`, ''])
  })

  it('a launch takes the bus of the process that starts it back into the session env the card port dropped it from', () => {
    expect(launchEnv({ PATH: '/bin' }, { [BUS_DB_VARIABLE]: LAUNCHING_BUS })).toEqual({ PATH: '/bin', [BUS_DB_VARIABLE]: LAUNCHING_BUS })
    expect(launchEnv({ PATH: '/bin' }, {})).toEqual({ PATH: '/bin' })
  })

  it('start() spawns the launch with the launching bus though envOf names none', () => {
    vi.stubEnv(BUS_DB_VARIABLE, LAUNCHING_BUS)
    const envs: NodeJS.ProcessEnv[] = []
    const held = heldTree(['notes.md'], { spawnDetached: (run) => {
      envs.push(run.env)
      return 4242
    } })
    expect(held.startQueued()).toMatchObject({ kind: 'started' })
    expect(envs.map(env => env[BUS_DB_VARIABLE])).toEqual([LAUNCHING_BUS])
  })
})

describe('the held tree guard reads the session journal', () => {
  it('a file the card session changed by Write or Edit, whose content matches and which the report does not name, continues in the held tree', () => {
    const held = heldTree(['notes.md', 'src/written.ts', 'src/edited.ts'])

    expect(held.start()).toMatchObject({ kind: 'started', card: { worktree: TREE, session: 'sess-next' } })
    expect(held.spawned).toEqual([TREE])
  })

  it('a held tree continued from start() reads the journals of the sessions the bus records for the card', () => {
    const asked: number[] = []
    const held = heldTree(['src/written.ts'], {
      cardSessions: (cardId) => {
        asked.push(cardId)
        return [SESSION]
      },
    })

    expect(held.startQueued()).toMatchObject({ kind: 'started', card: { worktree: TREE } })
    expect(asked).toEqual([CARD])
  })

  it('a file an earlier session of the card changed and the last session did not continues in the held tree', () => {
    const held = heldTree(['notes.md', 'src/written.ts', 'src/earlier.ts'], earlierSession)

    expect(held.start()).toMatchObject({ kind: 'started', card: { worktree: TREE, session: 'sess-next' } })
    expect(held.startQueued()).toMatchObject({ kind: 'started', card: { worktree: TREE } })
    expect(held.spawned).toEqual([TREE, TREE])
  })

  it('a file outside the journals of every session of the card is refused by name', () => {
    const held = heldTree(['notes.md', 'src/earlier.ts', 'src/foreign.ts'], earlierSession)

    const outcome = held.start()

    expect(refusedPaths(outcome)).toEqual(['src/foreign.ts'])
    expect(outcome.kind === 'refused' && outcome.denial.detail).toContain(`src/foreign.ts (session ${EARLIER}: the session journal holds no Write or Edit of it; session ${SESSION}: the session journal holds no Write or Edit of it)`)
    expect(held.spawned).toEqual([])
  })

  it('a file an earlier session wrote and something changed after that session ended is refused by name', () => {
    const held = heldTree(['src/earlier.ts'], { ...earlierSession, treeFile: file => path.relative(TREE, file) === 'src/earlier.ts' ? { content: 'earlier\n', mtimeMs: at(45) } : null })

    expect(refusedPaths(held.start())).toEqual(['src/earlier.ts'])
    expect(held.spawned).toEqual([])
  })

  it('an unreadable transcript of an earlier session is a safe refusal', () => {
    const held = heldTree(['src/written.ts'], { cardSessions: () => [EARLIER, SESSION] })

    const outcome = held.start()

    expect(refusedPaths(outcome)).toEqual(['src/written.ts'])
    expect(outcome.kind === 'refused' && outcome.denial.detail).toContain(`the journal of session ${EARLIER} cannot be read`)
    expect(held.spawned).toEqual([])
  })

  it('a held tree the report names whole never reads a journal', () => {
    const held = heldTree(['notes.md'], {
      cardSessions: () => {
        throw new Error('the journal is read only for an unnamed path')
      },
    })

    expect(held.startQueued().kind).toBe('started')
  })

  it('a foreign file in neither the report nor the journal is refused by name', () => {
    const held = heldTree(['notes.md', 'src/written.ts', 'src/foreign.ts'])

    const outcome = held.start()

    expect(outcome).toMatchObject({ kind: 'refused', denial: { reason: 'held_tree_changed', paths: ['src/foreign.ts'] } })
    expect(outcome.kind === 'refused' && outcome.denial.detail).toContain('src/foreign.ts (the session journal holds no Write or Edit of it)')
    expect(held.spawned).toEqual([])
  })

  it('a file changed after the session ended or by a Bash command is refused by name', () => {
    const held = heldTree(['src/edited.ts', 'src/late.ts', 'src/shelled.ts'])

    const outcome = held.start()

    expect(refusedPaths(outcome)).toEqual(['src/late.ts', 'src/shelled.ts'])
    expect(outcome.kind === 'refused' && outcome.denial.detail).toContain('src/late.ts (it changed after the session ended)')
    expect(outcome.kind === 'refused' && outcome.denial.detail).toContain('src/shelled.ts (it changed after the session\'s last Edit of it, by a Bash command or another writer)')
    expect(held.spawned).toEqual([])
  })

  it('an unreadable transcript is a safe refusal, not an admission', () => {
    const unreadable: Partial<StarterPorts>[] = [{ readTranscript: () => null }, { readTranscript: () => '{"type":"assistant", truncated' }, { readTranscript: () => '' }]
    for (const overrides of unreadable) {
      const held = heldTree(['notes.md', 'src/written.ts', 'src/edited.ts'], overrides)

      expect(held.start()).toMatchObject({ kind: 'refused', denial: { reason: 'held_tree_changed', paths: ['src/written.ts', 'src/edited.ts'] } })
      expect(held.spawned).toEqual([])
    }
  })

  it('a held tree the bus records no session of is refused by name', () => {
    const held = heldTree(['notes.md', 'src/written.ts'], { cardSessions: () => [] })

    const outcome = held.startQueued()

    expect(refusedPaths(outcome)).toEqual(['src/written.ts'])
    expect(outcome.kind === 'refused' && outcome.denial.detail).toContain('the bus records no session that held the tree')
    expect(held.spawned).toEqual([])
  })
})

describe('the sessions of a card on the bus', () => {
  it('are the sessions its card.started and card.answered events name, in order and once each', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'card-sessions-'))
    const busPath = path.join(root, 'bus.db')
    const db = openBus(busPath)
    const event = (id: number, type: string, cardId: number, payload: Record<string, unknown>): void => {
      appendEvent(db, { ts: stamp(id), type, actor: 'worker:launch:launch-1', cardId, pr: null, head: null, dedupeKey: `test:${id}`, payload, legacy: false })
    }
    try {
      event(1, CARD_STARTED, CARD, { session: EARLIER })
      event(2, CARD_ANSWERED, CARD, { session: 'sess-answer' })
      event(3, CARD_STARTED, CARD + 1, { session: 'sess-other-card' })
      event(4, CARD_STARTED, CARD, {})
      event(5, CARD_STOPPED, CARD, { session: 'sess-stopped' })
      event(6, CARD_STARTED, CARD, { session: SESSION })
      event(7, CARD_STARTED, CARD, { session: EARLIER })
      db.close()

      expect(busCardSessions(busPath)(CARD)).toEqual([EARLIER, 'sess-answer', SESSION])
      expect(busCardSessions(path.join(root, 'absent.db'))(CARD)).toEqual([])
    }
    finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
