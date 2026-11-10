import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { InMemoryGh, listPrs, readGhJson } from '../../ports/gh.js'
import { InMemoryGit } from '../../ports/git.js'
import { InMemorySessions } from '../../ports/session.js'
import { InMemoryPulls, takeSnapshot } from '../../ports/snapshot.js'
import { cutTree, InMemoryShell, InMemoryTrees } from '../../ports/worktree.js'

const spawned = vi.hoisted(() => [] as string[])

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>()
  const refused = (name: string) => (command: unknown) => {
    spawned.push(`${name} ${String(command)}`)
    throw new Error(`${name} ${String(command)} was spawned under an in-memory adapter`)
  }
  return { ...real, spawn: refused('spawn'), spawnSync: refused('spawnSync'), exec: refused('exec'), execSync: refused('execSync'), execFile: refused('execFile'), execFileSync: refused('execFileSync') }
})

const MAIN_SHA = 'a'.repeat(40)
const MERGE_SHA = 'b'.repeat(40)

afterEach(() => {
  expect(spawned).toEqual([])
})

describe('every port has an in-memory adapter that runs without git ps or gh', () => {
  it('the gh port answers from its script, retries a transient failure and records each call', () => {
    const pr = { number: 7, headRefName: 'feat/x', headRefOid: MAIN_SHA, state: 'OPEN', mergedAt: null, mergeCommit: null }
    let attempts = 0
    const gh = new InMemoryGh((args) => {
      if (args[0] === 'pr')
        return JSON.stringify([pr])
      attempts += 1
      return attempts === 1 ? { status: 1, stdout: '', stderr: 'HTTP 502' } : '{"ok":true}'
    })
    const caller = gh.caller()
    expect(listPrs(caller, 'owner/repo')).toEqual({ kind: 'listed', prs: [pr], truncated: false })
    expect(readGhJson(caller, ['api', 'user'])).toEqual({ kind: 'read', value: { ok: true } })
    expect(gh.calls.map(call => call.args[0])).toEqual(['pr', 'api', 'api'])
  })

  it('the gh port refuses a call its script fails, without a token lookup', () => {
    const gh = new InMemoryGh(() => ({ status: 1, stdout: '', stderr: 'not found' }))
    expect(gh.port().call(['pr', 'view', '7'])).toMatchObject({ kind: 'failed', cause: 'failed', attempts: 1 })
    expect(gh.calls).toHaveLength(1)
  })

  it('the session port writes the scripted output to the session files and returns its code', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'in-memory-session-'))
    const sessions = new InMemorySessions(params => params.role === 'review' ? { code: 0, stdout: 'verdict: pass\n' } : new Error('no client'))
    const params = { cwd: dir, sessionId: 's-1', prompt: 'review it', stdoutPath: path.join(dir, 'out'), stderrPath: path.join(dir, 'err') }
    await expect(sessions.spawnReview(params)).resolves.toBe(0)
    expect(readFileSync(params.stdoutPath, 'utf8')).toBe('verdict: pass\n')
    expect(readFileSync(params.stderrPath, 'utf8')).toBe('')
    await expect(sessions.spawn(params)).rejects.toThrow('no client')
    expect(sessions.started.map(each => each.role)).toEqual(['review', undefined])
  })

  it('the snapshot port reads a closed pull, an unsettled one and main from its endpoints', () => {
    const repo = 'repos/{owner}/{repo}'
    const pulls = new InMemoryPulls({
      [`${repo}/pulls?state=open&per_page=100`]: [{ number: 8, state: 'open', base: { ref: 'main' }, head: { sha: MAIN_SHA } }],
      [`${repo}/pulls/8`]: { number: 8, state: 'open', mergeable_state: 'unknown', base: { ref: 'main' }, head: { sha: MAIN_SHA } },
      [`${repo}/pulls/7`]: { number: 7, state: 'closed', merged: true, merge_commit_sha: MERGE_SHA, merged_by: { login: 'owner' }, merged_at: '2026-11-10T00:00:00Z', body: '#1672 card', base: { ref: 'main' }, head: { sha: MAIN_SHA, ref: 'feat/x' } },
      [`${repo}/commits/main`]: { sha: MAIN_SHA, files: [{ filename: 'README.md' }] },
    })
    const snapshot = takeSnapshot(pulls.meter(), [7], null)
    expect(snapshot.unsettled).toEqual([8])
    expect(snapshot.closed).toEqual([{ pr: 7, cardId: 1672, branch: 'feat/x', merged: true, commit: MERGE_SHA, mergedBy: 'owner', mergedAt: '2026-11-10T00:00:00Z' }])
    expect(snapshot.main).toEqual({ sha: MAIN_SHA, touchesMechanics: false })
    expect(() => takeSnapshot(new InMemoryPulls({}).meter(), [], null)).toThrow('404')
  })

  it('the worktree port cuts a tree through the in-memory git and records the install', () => {
    const git = new InMemoryGit(({ args }) => {
      if (args[0] === 'rev-parse')
        return '/repo\n'
      if (args[0] === 'show-ref')
        return new Error('no such ref')
      return ''
    })
    const trees = new InMemoryTrees('/repo', git, { held: ['/trees/9'] })
    const cut = cutTree({ ...trees, worktreeHome: '/trees' }, '1672', 'feat/x')
    expect(cut).toMatchObject({ origin: 'cut' })
    expect(git.calls.map(call => call.args[0])).toContain('worktree')
    expect(trees.installs).toEqual([{ cwd: (cut as { worktree: string }).worktree, args: ['install', '--prefer-offline'] }])
    expect(trees.holds('/trees/9')).toBe(true)
    const refused = cutTree({ ...new InMemoryTrees('/repo', git, { installRefusal: 'registry refused' }), worktreeHome: '/trees' }, '1672', 'feat/x')
    expect(refused).toMatchObject({ refused: expect.stringContaining('registry refused') })
  })

  it('the shell of the worktree port answers from its script', () => {
    const shell = new InMemoryShell(command => ({ status: command === 'pnpm run quality' ? 0 : 1, output: 'ok\n' }))
    expect(shell.shell('pnpm run quality', '/tree')).toEqual({ status: 0, output: 'ok\n' })
    expect(shell.shell('pnpm lint', '/tree').status).toBe(1)
    expect(shell.ran).toEqual([{ command: 'pnpm run quality', cwd: '/tree' }, { command: 'pnpm lint', cwd: '/tree' }])
  })
})
