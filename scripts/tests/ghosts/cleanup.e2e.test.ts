import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')
const WATCH = path.join(REPO_ROOT, 'scripts/ghosts/watch.ts')
const TSX_CLI = path.join(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs')
const TASK_LOGS = ['mc-g1.quality.log', 'mc-g1-quality-2.log']
const FOREIGN_LOG = 'mc-g10.quality.log'

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

function newWorld(prState: string, statusExtra = ''): World {
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
  writeFileSync(path.join(bin, 'gh'), `#!/usr/bin/env bash\ncat '${path.join(root, 'prs.json')}'\n`)
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

function watch(w: World): string {
  const result = spawnSync(process.execPath, [TSX_CLI, WATCH, '--tasks', path.join(w.root, 'tasks.json'), '--logs', w.logs], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${path.join(w.root, 'bin')}${path.delimiter}${process.env.PATH}` },
  })
  expect(result.stderr).toBe('')
  expect(result.status).toBe(0)
  return result.stdout
}

function logsLeft(w: World): string[] {
  return readdirSync(w.logs).sort()
}

afterEach(() => {
  for (const root of worlds.splice(0))
    rmSync(root, { recursive: true, force: true })
})

describe('the watch cleans up after a merged pull request', () => {
  it('w1: removes the worktree and the quality logs of the task once its PR is merged, and leaves the log of another task', () => {
    const w = newWorld('MERGED')
    const out = watch(w)
    expect(existsSync(w.worktree)).toBe(false)
    expect(logsLeft(w)).toEqual([FOREIGN_LOG])
    expect(out).toContain(`[ghosts:watch] ghost-g1 cleanup: PR #7 merged; removed worktree ${w.worktree} and 2 quality logs`)
  })

  it('w2: leaves the worktree and the logs while the PR is open', () => {
    const w = newWorld('OPEN')
    const out = watch(w)
    expect(existsSync(w.worktree)).toBe(true)
    expect(logsLeft(w)).toEqual([...TASK_LOGS, FOREIGN_LOG].sort())
    expect(out).not.toContain('cleanup')
  })

  it('w3: never touches a hand-ladder worktree, even with its PR merged', () => {
    const w = newWorld('MERGED', '| hand-ladder-g1 | the ladder runs by hand | Eli | 2026-10-01 09:00 |\n')
    const out = watch(w)
    expect(existsSync(w.worktree)).toBe(true)
    expect(logsLeft(w)).toEqual([...TASK_LOGS, FOREIGN_LOG].sort())
    expect(out).not.toContain('cleanup')
  })

  it('w4: keeps a dirty worktree with its PR merged and prints the reason', () => {
    const w = newWorld('MERGED')
    writeFileSync(path.join(w.worktree, 'unsaved.txt'), 'work in progress\n')
    const out = watch(w)
    expect(existsSync(path.join(w.worktree, 'unsaved.txt'))).toBe(true)
    expect(logsLeft(w)).toEqual([...TASK_LOGS, FOREIGN_LOG].sort())
    expect(out).toContain(`[ghosts:watch] ghost-g1 cleanup: PR #7 merged; kept ${w.worktree}: the worktree is dirty (1 changed paths)`)
  })

  it('leaves the worktree when the last review verdict is changes, even with its PR merged', () => {
    const w = newWorld('MERGED')
    writeFileSync(path.join(w.handoff, 'ghosts.jsonl'), `${JSON.stringify({ event: 'review', task: 'g1', verdict: 'changes', ts: '2026-10-01T09:00:00Z' })}\n`)
    const out = watch(w)
    expect(existsSync(w.worktree)).toBe(true)
    expect(logsLeft(w)).toEqual([...TASK_LOGS, FOREIGN_LOG].sort())
    expect(out).not.toContain('cleanup')
  })
})
