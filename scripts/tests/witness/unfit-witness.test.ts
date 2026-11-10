import type { DatabaseSync } from 'node:sqlite'
import type { TimedShellResult } from '../../nodes/witness/witness-executor.js'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parkingFileText } from '../../../src/card/parking.js'
import { textSha } from '../../../src/card/text-sha.js'
import { appendEvent, openBus } from '../../core/db.js'
import { CARD_ADMITTED, CARD_STOPPED, PR_OBSERVED, QUESTION_AGENT, WITNESS_RECORDED } from '../../core/events.js'
import { reduce } from '../../core/reducer.js'
import { UNFIT, WITNESS_UNFIT } from '../../nodes/witness/witness-executor.js'
import { WitnessNode } from '../../nodes/witness/witness-worker.js'
import { GREEN, RED, witnessDenial } from '../../policy/policy.js'
import { SetupTurns, withWorktreeAsync } from '../../ports/worktree.js'

const CARD = 1759
const PR = 2759
const NOW = '2026-11-10T10:02:00.000Z'
const ADDED_TEST = 'tests/newdir/a.test.ts'
const roots: string[] = []
const dbs: DatabaseSync[] = []

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  for (const db of dbs.splice(0))
    db.close()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, '-c', 'user.name=bus', '-c', 'user.email=bus@example.invalid', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' }).trim()
}

function commit(repo: string, files: Record<string, string>, message: string): string {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(repo, file)), { recursive: true })
    writeFileSync(path.join(repo, file), text)
    git(repo, 'add', file)
  }
  git(repo, 'commit', '-q', '-m', message)
  return git(repo, 'rev-parse', 'HEAD')
}

const VITEST_RUN = /vitest run (\S+)/

async function vitestLike(command: string, cwd: string): Promise<TimedShellResult> {
  const target = VITEST_RUN.exec(command)?.[1]
  const negated = command.trim().startsWith('!')
  const found = target !== undefined && existsSync(path.join(cwd, target))
  const ran = found ? { status: 0, output: ' Test Files  1 passed (1)\n      Tests  1 passed (1)\n' } : { status: 1, output: `No test files found, exiting with code 1\nfilter: ${target ?? ''}\n` }
  const status = negated ? (ran.status === 0 ? 1 : 0) : ran.status
  return { status, output: ran.output, timedOut: false }
}

interface World { db: DatabaseSync, repo: string, base: string, head: string }

const OUTSIDE_THE_TOUCHES = 'tests/other/c.test.ts'

function world(witnesses: readonly object[], headFiles: Record<string, string> = {}): World {
  const root = mkdtempSync(path.join(tmpdir(), 'unfit-witness-'))
  roots.push(root)
  const repo = path.join(root, 'repo')
  execFileSync('git', ['init', '-q', repo])
  const base = commit(repo, { 'README.md': 'base\n' }, 'base')
  const head = commit(repo, { [ADDED_TEST]: 'it passes\n', ...headFiles }, 'head')
  const db = openBus(path.join(root, 'bus.db'))
  dbs.push(db)
  const body = `Add the tests.\n\nwitnesses: ${JSON.stringify(witnesses)}`
  const text = parkingFileText({ card: `#${CARD} unfit [implement/construct/S/cheap/auto] · depends — · blocks —`, branch: 'feat/unfit', touches: ['tests/newdir/**'], continue: 'stop', who: 'shift', body })
  appendEvent(db, { ts: '2026-11-10T10:00:00.000Z', type: CARD_ADMITTED, actor: 'worker:intake:by-hand', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${CARD}`, payload: { card: `#${CARD}`, lane: 'lane-1', text, textSha: textSha(text), bodySha: textSha(text).slice(0, 12) }, legacy: false })
  appendEvent(db, { ts: '2026-11-10T10:01:00.000Z', type: PR_OBSERVED, actor: 'netwatch', cardId: CARD, pr: PR, head, dedupeKey: `${PR_OBSERVED}:${PR}:${head}`, payload: { card_id: CARD, base: 'main', head, mergeable: 'clean', ci: 'green', auto_merge: false, draft: false, body_sha: 'a'.repeat(64) }, legacy: false })
  reduce(db)
  return { db, repo, base, head }
}

async function witnessRun(w: World, gitDiff: 'reads' | 'fails' = 'reads'): Promise<void> {
  const turns = new SetupTurns()
  const withoutHeadObjects = async <T>(run: (tree: string) => Promise<T>): Promise<T> => {
    const tree = mkdtempSync(path.join(tmpdir(), 'unfit-witness-not-a-repo-'))
    roots.push(tree)
    return run(tree)
  }
  const trees = { baseOf: async () => w.base, withTree: <T>(base: string, run: (tree: string) => Promise<T>) => gitDiff === 'fails' ? withoutHeadObjects(run) : withWorktreeAsync(w.repo, base, run, turns) }
  const node = new WitnessNode({ db: w.db, clock: () => new Date(NOW), session: 'witness-1', mode: 'live', env: {}, shell: vitestLike, trees })
  for (let round = 0; round < 2; round += 1) {
    const controller = new AbortController()
    await node.run({ pause: async () => controller.abort(), signal: controller.signal })
  }
}

function payloadsOf(w: World, type: string): Record<string, unknown>[] {
  return (w.db.prepare('SELECT payload FROM events WHERE type = ? ORDER BY id').all(type) as { payload: string }[]).map(row => JSON.parse(row.payload) as Record<string, unknown>)
}

const DIRECTORY_WITNESS = { id: 'W1', run: 'pnpm exec vitest run tests/newdir', test: null, head: 'pass', base: 'pass', proves: 'the new directory passes' }
const FOREIGN_WITNESS = { id: 'W1', run: 'pnpm exec vitest run tests/other/b.test.ts', test: null, head: 'pass', base: 'fail', proves: 'a test another card writes' }
const STRICT_WITNESS = { id: 'W1', run: `pnpm exec vitest run ${ADDED_TEST}`, test: null, head: 'pass', base: 'fail', proves: 'the added test' }
const REPLACEMENT = { id: 'W1', run: `pnpm exec vitest run ${ADDED_TEST}`, test: null, head: 'pass', base: 'fail' }

describe('the witness node tells unfit from green and red on the base', () => {
  it('a card whose witness directory is absent on the base gets the verdict unfit with a replacement, not green', async () => {
    const w = world([DIRECTORY_WITNESS])
    await witnessRun(w)
    expect(payloadsOf(w, WITNESS_RECORDED).map(payload => payload.verdict)).toEqual([UNFIT])
    const [stopped] = payloadsOf(w, CARD_STOPPED)
    expect(stopped).toMatchObject({ reason: QUESTION_AGENT, code: WITNESS_UNFIT, paths: [ADDED_TEST] })
    expect(String(stopped!.detail)).toContain('ran no test on the base')
    expect(String(stopped!.detail)).toContain(`--witness W1=${JSON.stringify(REPLACEMENT).slice(0, -1)}`)
    expect(witnessDenial(w.db, CARD, w.head, w.base)).not.toBeNull()
  })

  it('a witness naming a file outside the touches that the head does not write is unfit, and nothing runs', async () => {
    const w = world([FOREIGN_WITNESS])
    await witnessRun(w)
    expect(payloadsOf(w, WITNESS_RECORDED).map(payload => payload.verdict)).toEqual([UNFIT])
    expect(String(payloadsOf(w, CARD_STOPPED)[0]!.detail)).toContain('tests/other/b.test.ts')
  })

  it('a witness naming a file the head adds outside the touches is not unfit', async () => {
    const w = world([{ ...FOREIGN_WITNESS, run: `pnpm exec vitest run ${OUTSIDE_THE_TOUCHES}` }], { [OUTSIDE_THE_TOUCHES]: 'it passes\n' })
    await witnessRun(w)
    expect(payloadsOf(w, WITNESS_RECORDED).map(payload => payload.verdict)).toEqual([GREEN])
  })

  it('a diff of the head that cannot be read leaves the witness unjudged, not unfit', async () => {
    const w = world([{ ...FOREIGN_WITNESS, run: `pnpm exec vitest run ${OUTSIDE_THE_TOUCHES}` }], { [OUTSIDE_THE_TOUCHES]: 'it passes\n' })
    await witnessRun(w, 'fails')
    expect(payloadsOf(w, WITNESS_RECORDED).map(payload => payload.verdict)).not.toContain(UNFIT)
    expect(payloadsOf(w, CARD_STOPPED).filter(payload => payload.code === WITNESS_UNFIT)).toEqual([])
  })

  it('a strict witness over the test the head adds stays green and stops nothing', async () => {
    const w = world([STRICT_WITNESS])
    await witnessRun(w)
    expect(payloadsOf(w, WITNESS_RECORDED).map(payload => payload.verdict)).toEqual([GREEN])
    expect(payloadsOf(w, CARD_STOPPED)).toEqual([])
  })

  it('a witness red for a reason stays red, not unfit', async () => {
    const w = world([{ ...STRICT_WITNESS, run: 'pnpm exec vitest run README.md', head: 'fail', base: 'pass' }])
    await witnessRun(w)
    expect(payloadsOf(w, WITNESS_RECORDED).map(payload => payload.verdict)).not.toContain(UNFIT)
    expect(payloadsOf(w, WITNESS_RECORDED).map(payload => payload.verdict)).toEqual([RED])
  })
})
