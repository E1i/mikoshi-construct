import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')
const CLEANUP = path.join(REPO_ROOT, 'scripts/ghosts/cleanup.ts')
const WATCH = path.join(REPO_ROOT, 'scripts/ghosts/watch.ts')
const TSX_CLI = path.join(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs')
const TASK_LOGS = ['mc-g1.quality.log', 'mc-g1-quality-2.log']
const FOREIGN_LOG = 'mc-g10.quality.log'
const ALL_LOGS = [...TASK_LOGS, FOREIGN_LOG].sort()

interface World {
  root: string
  worktree: string
  logs: string
  handoff: string
}

const worlds: string[] = []

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, '-c', 'user.name=world', '-c', 'user.email=world@example.invalid', ...args], { encoding: 'utf8', stdio: 'pipe' })
}

type GhMode = 'answers' | 'exits-1' | 'not-json'

const GH_STUBS: Record<GhMode, (prsFile: string) => string> = {
  'answers': prsFile => `if [ "$1" = repo ]; then echo '{"nameWithOwner":"world/repo"}'; else cat '${prsFile}'; fi`,
  'exits-1': () => 'echo "gh: not logged in" >&2; exit 1',
  'not-json': () => 'echo "<html>rate limited</html>"',
}

function newWorld(prState: string, statusExtra = '', ghMode: GhMode = 'answers'): World {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'cleanup-world-')))
  worlds.push(root)
  const repo = path.join(root, 'repo')
  const worktree = path.join(root, 'mc-g1')
  const logs = path.join(root, 'logs')
  const handoff = path.join(root, 'handoff')
  const bin = path.join(root, 'bin')
  for (const dir of [repo, logs, handoff, bin])
    mkdirSync(dir)

  git(repo, ['init', '-q', '-b', 'main'])
  writeFileSync(path.join(repo, 'README.md'), 'world\n')
  git(repo, ['add', '.'])
  git(repo, ['commit', '-q', '-m', 'world'])
  git(repo, ['worktree', 'add', '-q', '-b', 'ghost/g1', worktree])

  for (const name of [...TASK_LOGS, FOREIGN_LOG])
    writeFileSync(path.join(logs, name), 'quality\n')

  const prs = [{ number: 7, title: 'g1', headRefName: 'ghost/g1', headRefOid: 'a'.repeat(40), state: prState, mergedAt: prState === 'MERGED' ? '2026-10-01T10:00:00Z' : null, mergeCommit: null }]
  writeFileSync(path.join(root, 'prs.json'), JSON.stringify(prs))
  writeFileSync(path.join(bin, 'gh'), `#!/usr/bin/env bash\n${GH_STUBS[ghMode](path.join(root, 'prs.json'))}\n`)
  chmodSync(path.join(bin, 'gh'), 0o755)

  writeFileSync(path.join(handoff, 'status.md'), `| window | tree | state | sha | task start | waits for | updated |\n|---|---|---|---|---|---|---|\n\n| policy | value | set by | updated |\n|---|---|---|---|\n${statusExtra}`)
  writeFileSync(path.join(root, 'tasks.json'), JSON.stringify({
    repo,
    status: path.join(handoff, 'status.md'),
    out: handoff,
    tasks: [{ id: 'g1', brief: path.join(handoff, 'brief-g1.md'), worktree, branch: 'ghost/g1' }],
  }))
  return { root, worktree, logs, handoff }
}

function run(w: World, script: string, args: string[]): string {
  const result = spawnSync(process.execPath, [TSX_CLI, script, '--tasks', path.join(w.root, 'tasks.json'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${path.join(w.root, 'bin')}${path.delimiter}${process.env.PATH}` },
  })
  expect(result.stderr).toBe('')
  expect(result.status).toBe(0)
  return result.stdout
}

function startLines(w: World, extra: object[] = []): void {
  const lines = [
    { event: 'path', task: 'g1', path: 'cheap', started: '2026-10-02T07:00:00Z', session: 's1', worktree: w.worktree, branch: 'ghost/g1', ts: '2026-10-02T07:00:00Z' },
    { event: 'path', task: 'g1', path: 'cheap', pr: 7, verification: 'run', ts: '2026-10-02T07:30:00Z' },
    ...extra,
  ]
  writeFileSync(path.join(w.handoff, 'ghosts.jsonl'), lines.map(line => `${JSON.stringify(line)}\n`).join(''))
}

function cleanupFromHandoff(w: World): string {
  const result = spawnSync(process.execPath, [TSX_CLI, CLEANUP, '--logs', w.logs], {
    encoding: 'utf8',
    cwd: path.join(w.root, 'repo'),
    env: { ...process.env, CONSTRUCT_HANDOFF_DIR: w.handoff, PATH: `${path.join(w.root, 'bin')}${path.delimiter}${process.env.PATH}` },
  })
  expect(result.stderr).toBe('')
  expect(result.status).toBe(0)
  return result.stdout
}

function cleanup(w: World): string {
  return run(w, CLEANUP, ['--logs', w.logs])
}

function logsLeft(w: World): string[] {
  return readdirSync(w.logs).sort()
}

afterEach(() => {
  for (const root of worlds.splice(0))
    rmSync(root, { recursive: true, force: true })
})

describe('ghosts:cleanup removes a merged task\'s worktree and quality logs', () => {
  it('w1: removes the worktree and the quality logs of the task once its PR is merged, and leaves the log of another task', () => {
    const w = newWorld('MERGED')
    const out = cleanup(w)
    expect(existsSync(w.worktree)).toBe(false)
    expect(logsLeft(w)).toEqual([FOREIGN_LOG])
    expect(out).toBe(`[ghosts:cleanup] ghost-g1 removed: PR #7 merged; worktree ${w.worktree} and 2 quality logs\n`)
  })

  it('w2: keeps the worktree and the logs while the PR is open', () => {
    const w = newWorld('OPEN')
    expect(cleanup(w)).toBe('[ghosts:cleanup] ghost-g1 kept: PR #7 is OPEN, not merged\n')
    expect(existsSync(w.worktree)).toBe(true)
    expect(logsLeft(w)).toEqual(ALL_LOGS)
  })

  it('w3: never touches a hand-ladder worktree, even with its PR merged', () => {
    const w = newWorld('MERGED', '| hand-ladder-g1 | the ladder runs by hand | Eli | 2026-10-01 09:00 |\n')
    expect(cleanup(w)).toBe('[ghosts:cleanup] ghost-g1 kept: status.md policy hand-ladder-g1; a hand-ladder worktree is never removed\n')
    expect(existsSync(w.worktree)).toBe(true)
    expect(logsLeft(w)).toEqual(ALL_LOGS)
  })

  it('w4: keeps a dirty worktree with its PR merged and names the reason', () => {
    const w = newWorld('MERGED')
    writeFileSync(path.join(w.worktree, 'unsaved.txt'), 'work in progress\n')
    expect(cleanup(w)).toBe(`[ghosts:cleanup] ghost-g1 kept: PR #7 merged, but ${w.worktree} is dirty (1 changed paths)\n`)
    expect(existsSync(path.join(w.worktree, 'unsaved.txt'))).toBe(true)
    expect(logsLeft(w)).toEqual(ALL_LOGS)
  })

  it('w5: keeps the worktree when the last review verdict is changes, even with its PR merged', () => {
    const w = newWorld('MERGED')
    writeFileSync(path.join(w.handoff, 'ghosts.jsonl'), `${JSON.stringify({ event: 'review', task: 'g1', verdict: 'changes', ts: '2026-10-01T09:00:00Z' })}\n`)
    expect(cleanup(w)).toBe('[ghosts:cleanup] ghost-g1 kept: the last review verdict is changes\n')
    expect(existsSync(w.worktree)).toBe(true)
    expect(logsLeft(w)).toEqual(ALL_LOGS)
  })

  it.each(['exits-1', 'not-json'] as const)('w6: removes nothing and says gh unavailable when gh %s', (mode) => {
    const w = newWorld('MERGED', '', mode)
    expect(cleanup(w)).toBe('[ghosts:cleanup] ghost-g1 kept: gh unavailable; the pull request state is unknown\n')
    expect(existsSync(w.worktree)).toBe(true)
    expect(logsLeft(w)).toEqual(ALL_LOGS)
  })

  it('w7: the watch only reads, leaving a merged task\'s worktree and logs in place', () => {
    const w = newWorld('MERGED')
    run(w, WATCH, [])
    expect(existsSync(w.worktree)).toBe(true)
    expect(logsLeft(w)).toEqual(ALL_LOGS)
  })
})

describe('w4: ghosts:cleanup without --tasks reads the attempts from the journal', () => {
  it('w4: removes a merged, clean cheap tree named only by event:path lines, the worktree on one line and the PR number on another', () => {
    const w = newWorld('MERGED')
    startLines(w)
    const out = cleanupFromHandoff(w)
    expect(existsSync(w.worktree)).toBe(false)
    expect(out).toBe(`[ghosts:cleanup] ghost-g1 removed: PR #7 merged; worktree ${w.worktree} and 2 quality logs\n`)
  })
})

describe('w5: ghosts:cleanup never removes a tree no task names', () => {
  it('w5: keeps an unregistered tree whose branch PR is merged and which is clean, and says so', () => {
    const w = newWorld('OPEN')
    const stray = path.join(w.root, 'mc-stray')
    git(path.join(w.root, 'repo'), ['worktree', 'add', '-q', '-b', 'ghost/stray', stray])
    const prs = [
      { number: 7, title: 'g1', headRefName: 'ghost/g1', headRefOid: 'a'.repeat(40), state: 'OPEN', mergedAt: null, mergeCommit: null },
      { number: 8, title: 'stray', headRefName: 'ghost/stray', headRefOid: 'b'.repeat(40), state: 'MERGED', mergedAt: '2026-10-01T10:00:00Z', mergeCommit: null },
    ]
    writeFileSync(path.join(w.root, 'prs.json'), JSON.stringify(prs))
    startLines(w)
    const out = cleanupFromHandoff(w)
    expect(existsSync(stray)).toBe(true)
    expect(existsSync(w.worktree)).toBe(true)
    expect(out).toContain(`[ghosts:cleanup] unregistered ${stray} kept: named by no task\n`)
  })
})
