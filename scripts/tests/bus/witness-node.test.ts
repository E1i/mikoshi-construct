import type { DatabaseSync } from 'node:sqlite'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parkingFileText } from '../../../src/card/parking.js'
import { textSha } from '../../../src/card/text-sha.js'
import { appendEvent, openBus } from '../../bus/db.js'
import { RED, witnessDenial, witnessRecordOf, witnessSubjectOf } from '../../bus/policy.js'
import { reduce } from '../../bus/reducer.js'
import { WitnessNode } from '../../bus/witness-worker.js'
import { CARD_ADMITTED, PR_OBSERVED, WITNESS_RECORDED } from '../../core/events.js'
import { realShell, withWorktree } from '../../ports/worktree.js'

const CARD = 1301
const PR = 1201
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

function commit(repo: string, file: string, message: string): string {
  writeFileSync(path.join(repo, file), `${message}\n`)
  git(repo, 'add', file)
  git(repo, 'commit', '-q', '-m', message)
  return git(repo, 'rev-parse', 'HEAD')
}

interface World {
  repo: string
  db: DatabaseSync
  base: string
  head: string
}

function world(baseFiles: string[], headFile: string): World {
  const root = mkdtempSync(path.join(tmpdir(), 'witness-node-'))
  roots.push(root)
  const repo = path.join(root, 'repo')
  execFileSync('git', ['init', '-q', repo])
  let base = commit(repo, 'README.md', 'base')
  for (const file of baseFiles)
    base = commit(repo, file, `base ${file}`)
  const head = commit(repo, headFile, `head ${headFile}`)
  const db = openBus(path.join(root, 'bus.db'))
  dbs.push(db)
  const text = parkingFileText({ card: `#${CARD} witnessed [implement/netwatch/S/cheap/auto] · depends — · blocks —`, branch: 'feat/witnessed', touches: ['done.txt'], continue: 'stop', who: 'shift', body: 'Write done.txt.\n\nWitnesses:\n- `test -f done.txt` exits 0; red on main\n- `test -f README.md` exits 0' })
  appendEvent(db, { ts: '2026-10-21T10:00:00.000Z', type: CARD_ADMITTED, actor: 'worker:intake:by-hand', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${CARD}`, payload: { card: `#${CARD}`, lane: 'lane-1', text, textSha: textSha(text), bodySha: textSha(text).slice(0, 12) }, legacy: false })
  appendEvent(db, { ts: '2026-10-21T10:01:00.000Z', type: PR_OBSERVED, actor: 'netwatch', cardId: CARD, pr: PR, head, dedupeKey: `${PR_OBSERVED}:${PR}:${head}`, payload: { card_id: CARD, base: 'main', head, mergeable: 'clean', ci: 'green', auto_merge: false, draft: false, body_sha: 'a'.repeat(64) }, legacy: false })
  reduce(db)
  return { repo, db, base, head }
}

async function witnessRun(w: World): Promise<void> {
  const node = new WitnessNode({ db: w.db, clock: () => new Date('2026-10-21T10:02:00.000Z'), session: 'witness-1', mode: 'live', env: {}, shell: realShell, trees: { baseOf: () => w.base, withTree: (base, run) => withWorktree(w.repo, base, run) } })
  for (let round = 0; round < 2; round += 1) {
    const controller = new AbortController()
    await node.run({ pause: async () => controller.abort(), signal: controller.signal })
  }
}

function recorded(w: World): string[] {
  return (w.db.prepare(`SELECT dedupe_key FROM events WHERE type = ?`).all(WITNESS_RECORDED) as { dedupe_key: string }[]).map(row => row.dedupe_key)
}

describe('the witness node', () => {
  it('records every card witness red on the base and green on the head as one green record keyed by head, base and card body', async () => {
    const w = world([], 'done.txt')
    await witnessRun(w)

    const cardBody = witnessSubjectOf(w.db, CARD)!.cardBody
    expect(recorded(w)).toEqual([`${WITNESS_RECORDED}:${CARD}:${w.head}:${w.base}:${cardBody}`])
    expect(witnessDenial(w.db, CARD, w.head)).toBeNull()
  })

  it('a mutant head that leaves a witness red is denied as witness', async () => {
    const w = world([], 'other.txt')
    await witnessRun(w)

    const record = witnessRecordOf(w.db, CARD, w.head, witnessSubjectOf(w.db, CARD)!.cardBody)
    expect(record).toEqual(expect.objectContaining({ verdict: RED, base: w.base }))
    expect(record!.detail).toMatch(/^P8: positive control "`test -f done\.txt` exits 0; red on main" exits 1/)
    expect(witnessDenial(w.db, CARD, w.head)).toMatch(/is red: P8: positive control/)
  })

  it('a witness green on the base is denied as witness', async () => {
    const w = world(['done.txt'], 'other.txt')
    await witnessRun(w)

    const record = witnessRecordOf(w.db, CARD, w.head, witnessSubjectOf(w.db, CARD)!.cardBody)
    expect(record).toEqual(expect.objectContaining({ verdict: RED }))
    expect(record!.detail).toMatch(/^P7: witness .* exits 0 on the clean base/)
    expect(witnessDenial(w.db, CARD, w.head)).toMatch(/is red: P7/)
  })

  it('a card with no admitted witnesses is not held by the gate', () => {
    const w = world([], 'done.txt')
    expect(witnessDenial(w.db, CARD + 1, w.head)).toBeNull()
  })
})
