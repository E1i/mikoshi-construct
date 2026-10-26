import type { AnswerRun } from '../../nodes/answer/answerer.js'
import type { StarterPorts } from '../../nodes/launch/launch-starter.js'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parkingFileText } from '../../../src/card/parking.js'
import { appendEvent, openBus } from '../../core/db.js'
import { claudeAnswerer } from '../../nodes/answer/answerer.js'
import { ShiftCardStarter } from '../../nodes/launch/launch-starter.js'
import { renderPrompt } from '../../nodes/launch/prompt.js'
import { claudeResume } from '../../nodes/launch/tree-pr-cli.js'

const CARD = 1348
const SESSION = `card-session-${CARD}`
const SOURCES = ['--setting-sources', 'project,local']
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function treeIn(): { root: string, tree: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'setting-sources-'))
  roots.push(root)
  const tree = path.join(root, `mc-${CARD}`)
  mkdirSync(tree)
  writeFileSync(path.join(tree, 'construct.json'), `${JSON.stringify({ harness: { command: 'pnpm run quality' }, shift: { prepush: ['pnpm run gate'] } })}\n`)
  return { root, tree }
}

function sourcesOf(argv: readonly string[]): { sources: string | undefined, settings: boolean, user: boolean } {
  const sources = argv[argv.indexOf(SOURCES[0]!) + 1]
  return { sources: argv.includes(SOURCES[0]!) ? sources : undefined, settings: argv.includes('--settings'), user: sources?.split(',').includes('user') ?? false }
}

function launchArgv(): string[] {
  const { root, tree } = treeIn()
  const text = parkingFileText({ card: `#${CARD} a-card [implement/netwatch/S/cheap/auto] · depends — · blocks —`, branch: `feat/card-${CARD}`, touches: ['scripts/bus/**'], continue: 'stop', who: 'shift', body: 'Do the card.' })
  let args: string[] = []
  const ports: StarterPorts = {
    read: () => text,
    cut: () => tree,
    base: () => 'b'.repeat(40),
    spawnDetached: (run) => {
      args = run.args
      return 4242
    },
    pgidOf: () => 4242,
    kill: () => {},
    uuid: () => SESSION,
    envOf: () => ({}),
    prompt: (task, at) => renderPrompt('card {{card}} in {{worktree}}, report {{report}}\n\n', task, at),
    changedPaths: () => [],
    readReport: () => null,
    cardSessions: () => [],
    readTranscript: () => null,
    treeFile: () => null,
  }
  const started = new ShiftCardStarter({ launchDir: path.join(root, 'launch'), claude: 'claude', treePr: 'true' }, ports).start({ cardId: CARD, lane: 'lane-x' })
  expect(started.kind).toBe('started')
  return args.join(' ').replaceAll('\'', '').split(/\s+/)
}

function resumeArgv(): string[] {
  const { root, tree } = treeIn()
  const busPath = path.join(root, 'bus.db')
  const db = openBus(busPath)
  appendEvent(db, { ts: '2026-10-26T09:00:00.000Z', type: 'card.started', actor: 'worker:launch:1', cardId: CARD, pr: null, head: null, dedupeKey: `card.started:launch:${CARD}:1`, payload: { session: SESSION, worktree: tree, branch: 'feat/x' }, legacy: false })
  db.close()
  const claude = path.join(root, 'claude')
  const seen = path.join(root, 'seen.txt')
  writeFileSync(claude, `#!/bin/sh\nprintf '%s\\n' "$@" > ${seen}\n`)
  chmodSync(claude, 0o755)
  claudeResume(busPath, claude, 10_000)(CARD, tree, 'merge a fresh origin/main')
  return readFileSync(seen, 'utf8').trim().split('\n')
}

async function answerArgv(): Promise<string[][]> {
  const { root, tree } = treeIn()
  const runs: AnswerRun[] = []
  const heads = ['a'.repeat(40), 'e'.repeat(40)]
  await claudeAnswerer(path.join(root, 'answers'), {
    cardText: () => `#${CARD} a-card [implement/netwatch/S/cheap/owner]\n\nthe card body`,
    available: () => true,
    remoteHead: () => heads.shift() ?? null,
    spawn: async (run) => {
      runs.push(run)
      writeFileSync(run.stdoutPath, `${JSON.stringify({ type: 'result', subtype: 'success', result: 'answered' })}\n`)
      return 0
    },
    newSession: () => 'new-session-1',
    publish: () => {},
    context: () => 30_000,
    contextWarn: () => 200_000,
    diff: () => '',
  })({
    lease: { taskKey: `answer:${CARD}:1300`, queue: 'answer', cardId: CARD, pr: 1300, head: 'a'.repeat(40), leaseGen: 1, actor: 'worker:answer:worker-1' },
    source: { kind: 'changes', findings: ['the retry is missing'], events: [] },
    widened: null,
    card: { session: SESSION, worktree: tree, branch: `feat/card-${CARD}` },
  })
  return runs.map(run => run.argv)
}

describe('every start of a card session loads only the project and local setting sources beside the package settings', () => {
  const loaded = { sources: 'project,local', settings: true, user: false }

  it('the launch of a card', () => {
    expect(sourcesOf(launchArgv())).toEqual(loaded)
  })

  it('the resume after a refusal', () => {
    expect(sourcesOf(resumeArgv())).toEqual(loaded)
  })

  it('every run of the answer session', async () => {
    const argvs = await answerArgv()
    expect({ runs: argvs.length > 0, each: argvs.map(sourcesOf) }).toEqual({ runs: true, each: argvs.map(() => loaded) })
  })
})
