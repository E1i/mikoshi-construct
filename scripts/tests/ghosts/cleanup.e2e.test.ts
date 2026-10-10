import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { ghostRowState, upsertGhostRow, writingRow } from '../../ghosts/status.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')
const CLEANUP = path.join(REPO_ROOT, 'scripts/ghosts/cleanup.ts')
const WATCH = path.join(REPO_ROOT, 'scripts/ghosts/watch.ts')
const TSX_CLI = path.join(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs')
const TASK_LOGS = ['mc-g1.quality.log', 'mc-g1-quality-2.log']
const FOREIGN_LOG = 'mc-g10.quality.log'
const ALL_LOGS = [...TASK_LOGS, FOREIGN_LOG].sort()
const CARD = '#41 world-g1 [implement/ghosts/S/ladder/owner] · depends — · blocks —'
const BRANCH = 'feat/g1'

interface World {
  root: string
  repo: string
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
  writeFileSync(path.join(repo, '.gitignore'), '.construct/\n')
  git(repo, ['add', '.'])
  git(repo, ['commit', '-q', '-m', 'world'])
  git(repo, ['worktree', 'add', '-q', '-b', BRANCH, worktree])

  for (const name of [...TASK_LOGS, FOREIGN_LOG])
    writeFileSync(path.join(logs, name), 'quality\n')

  const prs = [{ number: 7, title: 'g1', headRefName: BRANCH, headRefOid: 'a'.repeat(40), state: prState, mergedAt: prState === 'MERGED' ? '2026-10-01T10:00:00Z' : null, mergeCommit: null }]
  writeFileSync(path.join(root, 'prs.json'), JSON.stringify(prs))
  writeFileSync(path.join(bin, 'gh'), `#!/usr/bin/env bash\n${GH_STUBS[ghMode](path.join(root, 'prs.json'))}\n`)
  chmodSync(path.join(bin, 'gh'), 0o755)

  writeFileSync(path.join(handoff, 'status.md'), `| window | tree | state | sha | task start | waits for | updated |\n|---|---|---|---|---|---|---|\n\n| policy | value | set by | updated |\n|---|---|---|---|\n${statusExtra}`)
  writeFileSync(path.join(root, 'tasks.json'), JSON.stringify({
    repo,
    status: path.join(handoff, 'status.md'),
    out: handoff,
    tasks: [{ id: 'g1', brief: path.join(handoff, 'brief-g1.md'), card: CARD }],
  }))
  const w = { root, repo, worktree, logs, handoff }
  journal(w, [])
  return w
}

function startLine(w: World): object {
  return { event: 'path', task: '41', path: 'ladder', started: '2026-10-02T07:00:00Z', worktree: w.worktree, branch: BRANCH, ts: '2026-10-02T07:00:00Z' }
}

function runRaw(w: World, script: string, args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync(process.execPath, [TSX_CLI, script, '--tasks', path.join(w.root, 'tasks.json'), ...args], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${path.join(w.root, 'bin')}${path.delimiter}${process.env.PATH}` },
  })
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
  writeFileSync(path.join(w.handoff, 'ghosts.jsonl'), [
    { event: 'path', task: '41', path: 'cheap', started: '2026-10-02T07:00:00Z', session: 's1', worktree: w.worktree, branch: BRANCH, ts: '2026-10-02T07:00:00Z' },
    { event: 'path', task: '41', path: 'cheap', pr: 7, verification: 'run', ts: '2026-10-02T07:30:00Z' },
    ...extra,
  ].map(line => `${JSON.stringify(line)}\n`).join(''))
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

const CHANGES = { event: 'review', task: 'g1', verdict: 'changes', ts: '2026-10-01T09:00:00Z' }

function disposition(pr: number): object {
  return { event: 'disposition', ts: '2026-10-01T09:30:00Z', task: 'g1', decision: 'merge-follow-up', pr, followUp: 519, by: 'window' }
}

function journal(w: World, lines: object[]): void {
  writeFileSync(path.join(w.handoff, 'ghosts.jsonl'), [startLine(w), ...lines].map(line => `${JSON.stringify(line)}\n`).join(''))
}

function cleanup(w: World): string {
  return run(w, CLEANUP, ['--logs', w.logs])
}

const RUN_A = { run: 'wf_a', at: '2026-10-01T10:00:00.000Z', task: 'a', effort: 'low', status: 'done', rung: 'low', attempts: [], agents: 1, tokens: 10, toolUses: 1, seconds: 60 }
const RUN_B = { ...RUN_A, run: 'wf_b', at: '2026-10-02T10:00:00.000Z', task: 'b' }
const OLDER = { ...RUN_A, run: 'wf_old', at: '2026-09-20T10:00:00.000Z', task: 'old' }

function mainLedger(w: World): string {
  return path.join(w.repo, '.construct', 'runs.jsonl')
}

function writeLedger(file: string, rows: object[]): void {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, rows.map(row => `${JSON.stringify(row)}\n`).join(''))
}

function ledgerRuns(file: string): string[] {
  return readFileSync(file, 'utf8').split('\n').filter(line => line !== '').map(line => (JSON.parse(line) as { run: string }).run)
}

const STEPS_A = { v: 1, run: 'wf_a', steps: [{ step: 'implement', role: 'implementer', attempt: 1, effort: 'low', tokens: 10, seconds: 60 }] }
const STEPS_B = { ...STEPS_A, run: 'wf_b' }

function mainStepCache(w: World): string {
  return path.join(w.repo, '.construct', 'steps.jsonl')
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
    expect(out).toBe(`[ghosts:cleanup] ghost-g1 removed: PR #7 merged; 0 ledger lines carried into ${mainLedger(w)}; worktree ${w.worktree} and 2 quality logs\n`)
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
    journal(w, [CHANGES])
    expect(cleanup(w)).toBe('[ghosts:cleanup] ghost-g1 kept: the last review verdict is changes\n')
    expect(existsSync(w.worktree)).toBe(true)
    expect(logsLeft(w)).toEqual(ALL_LOGS)
  })

  it('w8: removes a merged task whose last review verdict is changes once a merge + follow-up disposition names its PR', () => {
    const w = newWorld('MERGED')
    journal(w, [CHANGES, disposition(7)])
    const out = cleanup(w)
    expect(existsSync(w.worktree)).toBe(false)
    expect(logsLeft(w)).toEqual([FOREIGN_LOG])
    expect(out).toBe(`[ghosts:cleanup] ghost-g1 removed: PR #7 merged over a changes verdict, follow-up #519; 0 ledger lines carried into ${mainLedger(w)}; worktree ${w.worktree} and 2 quality logs\n`)
  })

  it.each([
    { name: 'its PR is open', state: 'OPEN', lines: () => [CHANGES, disposition(7)] },
    { name: 'it names another PR', state: 'MERGED', lines: () => [CHANGES, disposition(8)] },
    { name: 'a later review says changes again', state: 'MERGED', lines: () => [CHANGES, disposition(7), CHANGES] },
  ])('w9: keeps the worktree under a changes verdict with a disposition when $name', ({ state, lines }) => {
    const w = newWorld(state)
    journal(w, lines())
    expect(cleanup(w)).toMatch(/^\[ghosts:cleanup\] ghost-g1 kept: the last review verdict is changes/)
    expect(existsSync(w.worktree)).toBe(true)
    expect(logsLeft(w)).toEqual(ALL_LOGS)
  })

  it('w9: names the PR the disposition waits for when it is not merged', () => {
    const w = newWorld('OPEN')
    journal(w, [CHANGES, disposition(7)])
    expect(cleanup(w)).toBe('[ghosts:cleanup] ghost-g1 kept: the last review verdict is changes, and its disposition merge + follow-up #519 lifts it only once PR #7 of feat/g1 is merged\n')
  })

  it('w10: removes a merged task whose last review verdict is pass, as before (control)', () => {
    const w = newWorld('MERGED')
    journal(w, [CHANGES, { ...CHANGES, verdict: 'pass' }])
    expect(cleanup(w)).toBe(`[ghosts:cleanup] ghost-g1 removed: PR #7 merged; 0 ledger lines carried into ${mainLedger(w)}; worktree ${w.worktree} and 2 quality logs\n`)
    expect(existsSync(w.worktree)).toBe(false)
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
    expect(out).toBe(`[ghosts:cleanup] ghost-41 removed: PR #7 merged; 0 ledger lines carried into ${mainLedger(w)}; worktree ${w.worktree} and 2 quality logs\n`)
  })

  it('w11: folds a Ghost\'s tasks id into its card, so a merge + follow-up disposition on the Ghost lifts the changes verdict and the tree is removed, not reported unregistered', () => {
    const w = newWorld('MERGED')
    writeFileSync(path.join(w.handoff, 'tasks-g1.json'), readFileSync(path.join(w.root, 'tasks.json')))
    journal(w, [CHANGES, disposition(7)])
    const out = cleanupFromHandoff(w)
    expect(out).toBe(`[ghosts:cleanup] ghost-g1 removed: PR #7 merged over a changes verdict, follow-up #519; 0 ledger lines carried into ${mainLedger(w)}; worktree ${w.worktree} and 2 quality logs\n`)
    expect(existsSync(w.worktree)).toBe(false)
  })

  it('w11: keeps the tree of a Ghost whose changes verdict no disposition lifts, reading the verdict through its card', () => {
    const w = newWorld('MERGED')
    writeFileSync(path.join(w.handoff, 'tasks-g1.json'), readFileSync(path.join(w.root, 'tasks.json')))
    journal(w, [CHANGES])
    expect(cleanupFromHandoff(w)).toBe('[ghosts:cleanup] ghost-g1 kept: the last review verdict is changes\n')
    expect(existsSync(w.worktree)).toBe(true)
  })
})

describe('w5: ghosts:cleanup never removes a tree no task names', () => {
  it('w5: keeps an unregistered tree whose branch PR is merged and which is clean, and says so', () => {
    const w = newWorld('OPEN')
    const stray = path.join(w.root, 'mc-stray')
    git(path.join(w.root, 'repo'), ['worktree', 'add', '-q', '-b', 'ghost/stray', stray])
    const prs = [
      { number: 7, title: 'g1', headRefName: BRANCH, headRefOid: 'a'.repeat(40), state: 'OPEN', mergedAt: null, mergeCommit: null },
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

describe('ghosts:cleanup carries a tree\'s ledger lines into the main ledger before it removes the tree', () => {
  it('l1: a tree with two lines, one already in the main ledger, leaves both in the main ledger once, in order, and the tree removed', () => {
    const w = newWorld('MERGED')
    writeLedger(mainLedger(w), [OLDER, RUN_A])
    writeLedger(path.join(w.worktree, '.construct', 'runs.jsonl'), [RUN_A, RUN_B])
    const out = cleanup(w)
    expect(ledgerRuns(mainLedger(w))).toEqual(['wf_old', 'wf_a', 'wf_b'])
    expect(existsSync(w.worktree)).toBe(false)
    expect(out).toBe(`[ghosts:cleanup] ghost-g1 removed: PR #7 merged; 1 ledger lines carried into ${mainLedger(w)}; worktree ${w.worktree} and 2 quality logs\n`)
  })

  it('l2: keeps the tree and names the reason when the main ledger cannot be written', () => {
    const w = newWorld('MERGED')
    writeLedger(mainLedger(w), [OLDER])
    chmodSync(mainLedger(w), 0o444)
    writeLedger(path.join(w.worktree, '.construct', 'runs.jsonl'), [RUN_A])
    const out = cleanup(w)
    expect(existsSync(path.join(w.worktree, '.construct', 'runs.jsonl'))).toBe(true)
    expect(logsLeft(w)).toEqual(ALL_LOGS)
    expect(out).toContain(`[ghosts:cleanup] ghost-g1 kept: PR #7 merged, but its ledger lines could not be carried into ${mainLedger(w)}: EACCES`)
    expect(ledgerRuns(mainLedger(w))).toEqual(['wf_old'])
  })

  it('l3: --ledger-only carries the lines of a tree whose PR is still open and removes nothing', () => {
    const w = newWorld('OPEN')
    writeLedger(path.join(w.worktree, '.construct', 'runs.jsonl'), [RUN_A, RUN_B])
    const result = runRaw(w, CLEANUP, ['--logs', w.logs, '--ledger-only'])
    expect(result.stderr).toBe('')
    expect(result.stdout).toBe(`[ghosts:cleanup] ghost-g1 ledger: 2 lines carried into ${mainLedger(w)}; worktree kept\n`)
    expect(ledgerRuns(mainLedger(w))).toEqual(['wf_a', 'wf_b'])
    expect(existsSync(w.worktree)).toBe(true)
    expect(logsLeft(w)).toEqual(ALL_LOGS)
  })
})

describe('ghosts:cleanup carries a tree\'s step cache lines into the main step cache before it removes the tree', () => {
  it('s1: a tree with two step cache lines, one already in the main cache, leaves both in the main cache once, in order, and the tree removed', () => {
    const w = newWorld('MERGED')
    writeLedger(mainStepCache(w), [STEPS_A])
    writeLedger(path.join(w.worktree, '.construct', 'steps.jsonl'), [STEPS_A, STEPS_B])
    const out = cleanup(w)
    expect(ledgerRuns(mainStepCache(w))).toEqual(['wf_a', 'wf_b'])
    expect(existsSync(w.worktree)).toBe(false)
    expect(out).toBe(`[ghosts:cleanup] ghost-g1 removed: PR #7 merged; 0 ledger lines carried into ${mainLedger(w)}; 1 step cache lines carried into ${mainStepCache(w)}; worktree ${w.worktree} and 2 quality logs\n`)
  })

  it('s2: keeps the tree and names the reason when the main step cache cannot be written', () => {
    const w = newWorld('MERGED')
    writeLedger(mainStepCache(w), [STEPS_A])
    chmodSync(mainStepCache(w), 0o444)
    writeLedger(path.join(w.worktree, '.construct', 'steps.jsonl'), [STEPS_B])
    const out = cleanup(w)
    expect(existsSync(path.join(w.worktree, '.construct', 'steps.jsonl'))).toBe(true)
    expect(logsLeft(w)).toEqual(ALL_LOGS)
    expect(out).toContain(`[ghosts:cleanup] ghost-g1 kept: PR #7 merged, but its step cache lines could not be carried into ${mainStepCache(w)}: EACCES`)
    expect(ledgerRuns(mainStepCache(w))).toEqual(['wf_a'])
  })

  it('s3: --ledger-only carries the step cache lines of a tree whose PR is still open and removes nothing', () => {
    const w = newWorld('OPEN')
    writeLedger(path.join(w.worktree, '.construct', 'runs.jsonl'), [RUN_A])
    writeLedger(path.join(w.worktree, '.construct', 'steps.jsonl'), [STEPS_A, STEPS_B])
    const result = runRaw(w, CLEANUP, ['--logs', w.logs, '--ledger-only'])
    expect(result.stderr).toBe('')
    expect(result.stdout).toBe(`[ghosts:cleanup] ghost-g1 ledger: 1 lines carried into ${mainLedger(w)}; 2 step cache lines carried into ${mainStepCache(w)}; worktree kept\n`)
    expect(ledgerRuns(mainStepCache(w))).toEqual(['wf_a', 'wf_b'])
    expect(existsSync(w.worktree)).toBe(true)
  })
})

function ghostRow(w: World, state: string, outcome: string): void {
  const statusPath = path.join(w.handoff, 'status.md')
  const row = `| ghost-g1 | ${w.worktree} | ${state} | ${'c'.repeat(40)} | 2026-10-02 07:00 | ${outcome} | 2026-10-02 08:00 |`
  writeFileSync(statusPath, readFileSync(statusPath, 'utf8').replace('|---|---|---|---|---|---|---|\n', `|---|---|---|---|---|---|---|\n${row}\n`))
}

function blockedWorld(prs: object[], outcome = (report: string) => `exit 0; ladder blocked; report ${report}; session s1`): { w: World, report: string } {
  const w = newWorld('OPEN')
  writeFileSync(path.join(w.root, 'prs.json'), JSON.stringify(prs))
  const report = path.join(w.handoff, 'ghost-g1.jsonl')
  writeFileSync(report, '{"type":"result"}\n')
  ghostRow(w, 'free', outcome(report))
  return { w, report }
}

function hasBranch(w: World, branch: string): boolean {
  return git(w.repo, ['branch', '--list', branch]).trim() !== ''
}

describe('b: ghosts:cleanup keeps the tree of a run that ended blocked with no pull request', () => {
  it('b1: keeps the tree, the branch, the uncommitted work and the report, for the next attempt on the card', () => {
    const { w, report } = blockedWorld([])
    writeFileSync(path.join(w.worktree, 'unsaved.txt'), 'blocked work\n')
    expect(cleanup(w)).toBe('[ghosts:cleanup] ghost-g1 kept: ladder blocked; the task\'s tree stays for the next attempt\n')
    expect(existsSync(path.join(w.worktree, 'unsaved.txt'))).toBe(true)
    expect(hasBranch(w, BRANCH)).toBe(true)
    expect(existsSync(report)).toBe(true)
    expect(existsSync(path.join(w.handoff, 'ghost-g1.removed.patch'))).toBe(false)
    expect(logsLeft(w)).toEqual(ALL_LOGS)
  })

  it.each([
    'exit 1; ladder done; report {report}; session s1',
    'exit 0; no ladder run; report {report}; session s1',
  ])('b6: keeps a run with no pull request whose outcome is "%s", not ladder blocked, and names the outcome', (template) => {
    const { w, report } = blockedWorld([], path => template.replace('{report}', path))
    writeFileSync(path.join(w.worktree, 'unsaved.txt'), 'work\n')
    const outcome = template.replace('{report}', report)
    expect(cleanup(w)).toBe(`[ghosts:cleanup] ghost-g1 kept: no pull request for feat/g1, and status.md says "${outcome}", not ladder blocked\n`)
    expect(existsSync(path.join(w.worktree, 'unsaved.txt'))).toBe(true)
    expect(hasBranch(w, BRANCH)).toBe(true)
    expect(existsSync(report)).toBe(true)
    expect(logsLeft(w)).toEqual(ALL_LOGS)
  })

  it('b2: keeps a blocked run whose branch has an open pull request', () => {
    const { w, report } = blockedWorld([{ number: 7, title: 'g1', headRefName: BRANCH, headRefOid: 'a'.repeat(40), state: 'OPEN', mergedAt: null, mergeCommit: null }])
    expect(cleanup(w)).toBe('[ghosts:cleanup] ghost-g1 kept: PR #7 is OPEN, not merged\n')
    expect(existsSync(w.worktree)).toBe(true)
    expect(hasBranch(w, BRANCH)).toBe(true)
    expect(existsSync(report)).toBe(true)
  })

  it('b3: keeps a run that is still writing, with no pull request yet', () => {
    const w = newWorld('OPEN')
    writeFileSync(path.join(w.root, 'prs.json'), '[]')
    ghostRow(w, 'writing', '/implement brief-g1.md, session s1')
    expect(cleanup(w)).toBe('[ghosts:cleanup] ghost-g1 kept: no pull request for feat/g1\n')
    expect(existsSync(w.worktree)).toBe(true)
    expect(hasBranch(w, BRANCH)).toBe(true)
  })
})

const OLD_SKETCH = 'a'.repeat(40)
const NEW_SKETCH = 'b'.repeat(40)

function approve(w: World, sketch: string): void {
  writeFileSync(path.join(w.handoff, 'brief-g1.approved-sha256'), `sha256: ${'d'.repeat(64)}\nsketch: ${sketch}\n`)
}

function dirtyOnOldSketch(w: World, approved: string): void {
  journal(w, [{ event: 'task', task: 'g1', sketch: OLD_SKETCH, ts: '2026-10-02T08:00:00Z' }])
  approve(w, approved)
  writeFileSync(path.join(w.worktree, 'README.md'), 'changed\n')
  writeFileSync(path.join(w.worktree, 'unsaved.txt'), 'new work\n')
}

function supersedeWorld(approved: string, outcome?: (report: string) => string): { w: World, report: string } {
  const world = blockedWorld([], outcome ?? (report => `exit 0; ladder done; report ${report}; session s1`))
  dirtyOnOldSketch(world.w, approved)
  return world
}

const BLOCKED_OUTCOME_LINE = (report: string): string => `exit 0; ladder blocked; report ${report}; session s1`

describe.each([
  ['done', undefined],
  ['blocked', BLOCKED_OUTCOME_LINE],
])('%s run and the approval', (kind, outcome) => {
  it(`${kind}-superseded: releases the run, saves the work as a patch and keeps the tree and branch`, () => {
    const { w, report } = supersedeWorld(NEW_SKETCH, outcome)
    const patch = path.join(w.handoff, `ghost-g1.done-${'a'.repeat(7)}.patch`)
    expect(cleanup(w)).toBe(`[ghosts:cleanup] ghost-g1 released: superseded by sketch ${'b'.repeat(7)}; work saved to ${patch}; tree ${w.worktree} clean for the next attempt\n`)
    expect(existsSync(patch)).toBe(true)
    const fresh = path.join(w.root, 'fresh')
    git(w.repo, ['worktree', 'add', '-q', '--detach', fresh, 'HEAD'])
    expect(() => git(fresh, ['apply', '--check', patch])).not.toThrow()
    git(fresh, ['apply', patch])
    expect(readFileSync(path.join(fresh, 'unsaved.txt'), 'utf8')).toBe('new work\n')
    expect(git(w.worktree, ['status', '--porcelain'])).toBe('')
    expect(existsSync(w.worktree)).toBe(true)
    expect(hasBranch(w, BRANCH)).toBe(true)
    expect(existsSync(report)).toBe(true)
    const superseded = readFileSync(path.join(w.handoff, 'ghosts.jsonl'), 'utf8').split('\n').filter(line => line !== '').map(line => JSON.parse(line) as { event: string, task?: string, by?: string }).find(line => line.event === 'superseded')
    expect(superseded).toMatchObject({ event: 'superseded', task: 'g1', by: NEW_SKETCH })
  })

  it(`${kind}-own-sketch: keeps the run with today's line while the approval names the run's own sketch`, () => {
    const { w, report } = supersedeWorld(OLD_SKETCH, outcome)
    const today = outcome === undefined
      ? `no pull request for feat/g1, and status.md says "exit 0; ladder done; report ${report}; session s1", not ladder blocked`
      : 'ladder blocked; the task\'s tree stays for the next attempt'
    expect(cleanup(w)).toBe(`[ghosts:cleanup] ghost-g1 kept: ${today}\n`)
    expect(git(w.worktree, ['status', '--porcelain'])).not.toBe('')
    expect(existsSync(path.join(w.handoff, `ghost-g1.done-${'a'.repeat(7)}.patch`))).toBe(false)
  })
})

describe('superseded, but not released', () => {
  it('superseded-writing: keeps a run that is still writing, its tree dirty, under an approval that names another sketch', () => {
    const w = newWorld('OPEN')
    writeFileSync(path.join(w.root, 'prs.json'), '[]')
    ghostRow(w, 'writing', '/implement brief-g1.md, session s1')
    dirtyOnOldSketch(w, NEW_SKETCH)
    expect(cleanup(w)).toBe('[ghosts:cleanup] ghost-g1 kept: no pull request for feat/g1\n')
    expect(readFileSync(path.join(w.worktree, 'unsaved.txt'), 'utf8')).toBe('new work\n')
  })

  it.each([
    'exit 1; ladder done; report {report}; session s1',
    'exit 0; no ladder run; report {report}; session s1',
  ])('superseded-unfinished: keeps a run whose outcome is "%s", its tree dirty, under an approval that names another sketch', (template) => {
    const { w, report } = supersedeWorld(NEW_SKETCH, path => template.replace('{report}', path))
    const outcome = template.replace('{report}', report)
    expect(cleanup(w)).toBe(`[ghosts:cleanup] ghost-g1 kept: no pull request for feat/g1, and status.md says "${outcome}", not ladder blocked\n`)
    expect(readFileSync(path.join(w.worktree, 'unsaved.txt'), 'utf8')).toBe('new work\n')
  })

  it('superseded-unapproved: keeps a done run whose brief has no approval file, its tree dirty', () => {
    const { w, report } = supersedeWorld(NEW_SKETCH)
    rmSync(path.join(w.handoff, 'brief-g1.approved-sha256'))
    expect(cleanup(w)).toBe(`[ghosts:cleanup] ghost-g1 kept: no pull request for feat/g1, and status.md says "exit 0; ladder done; report ${report}; session s1", not ladder blocked\n`)
    expect(git(w.worktree, ['status', '--porcelain'])).not.toBe('')
  })

  it('superseded-patch-exists: keeps the tree dirty when the patch path is already taken, and leaves that file as it was', () => {
    const { w } = supersedeWorld(NEW_SKETCH)
    const patch = path.join(w.handoff, `ghost-g1.done-${'a'.repeat(7)}.patch`)
    writeFileSync(patch, 'earlier\n')
    expect(cleanup(w)).toContain(`[ghosts:cleanup] ghost-g1 kept: its uncommitted work could not be saved to ${patch}: EEXIST`)
    expect(readFileSync(patch, 'utf8')).toBe('earlier\n')
    expect(readFileSync(path.join(w.worktree, 'unsaved.txt'), 'utf8')).toBe('new work\n')
    expect(git(w.worktree, ['status', '--porcelain'])).toContain('README.md')
  })
})

describe('superseded without --tasks', () => {
  it('handoff-superseded: releases a done run read from the journal and the tasks files in the handoff directory', () => {
    const { w } = supersedeWorld(NEW_SKETCH)
    writeFileSync(path.join(w.handoff, 'tasks-g1.json'), readFileSync(path.join(w.root, 'tasks.json')))
    const patch = path.join(w.handoff, `ghost-g1.done-${'a'.repeat(7)}.patch`)
    expect(cleanupFromHandoff(w)).toBe(`[ghosts:cleanup] ghost-g1 released: superseded by sketch ${'b'.repeat(7)}; work saved to ${patch}; tree ${w.worktree} clean for the next attempt\n`)
    expect(git(w.worktree, ['status', '--porcelain'])).toBe('')
  })
})

const LAUNCH = path.join(REPO_ROOT, 'scripts/ghosts/launch.ts')
const LAUNCH_WORLD = path.join(REPO_ROOT, 'scripts/tests/ghosts/fixtures/world.sh')
const launchWorlds: string[] = []

function launchWorld(...args: string[]): string {
  const result = spawnSync('bash', [LAUNCH_WORLD, ...args], { encoding: 'utf8' })
  if (result.status !== 0)
    throw new Error(`world.sh ${args.join(' ')} exited ${result.status}: ${result.stderr}`)
  return result.stdout.trim()
}

afterEach(() => {
  for (const w of launchWorlds.splice(0))
    launchWorld('clean', w)
})

interface KilledWorld {
  w: string
  tree: string
  status: string
  report: string
  aside: string
}

function deadPid(): number {
  return spawnSync('true').pid!
}

function killedGhostWorld(supervisor: number): KilledWorld {
  const w = launchWorld('new', 'ok')
  launchWorlds.push(w)
  const tree = path.join(w, 'wt-g1')
  const status = path.join(w, 'handoff', 'status.md')
  const report = path.join(w, 'handoff', 'ghost-g1.jsonl')
  const base = git(tree, ['rev-parse', 'HEAD']).trim()
  const row = writingRow({ id: 'g1', worktree: tree, baseSha: base, start: '2026-10-09 21:00', briefFileName: 'brief-g1.md', supervisorPid: supervisor, sessionId: 's1' })
  writeFileSync(status, upsertGhostRow(readFileSync(status, 'utf8'), 'g1', row))
  writeFileSync(report, '{"type":"system"}\n')
  for (const file of ['sketch-a.ts', 'sketch-b.ts'])
    writeFileSync(path.join(tree, file), `${file}\n`)
  git(tree, ['add', 'sketch-a.ts', 'sketch-b.ts'])
  const stub = path.join(w, 'gh-stub')
  mkdirSync(stub)
  writeFileSync(path.join(stub, 'gh'), `#!/usr/bin/env bash\nif [ "$1" = repo ]; then echo '{"nameWithOwner":"world/repo"}'; else echo '[]'; fi\n`)
  chmodSync(path.join(stub, 'gh'), 0o755)
  return { w, tree, status, report, aside: path.join(w, 'handoff', `ghost-g1.killed-${supervisor}.jsonl`) }
}

function cleanupKilled(k: KilledWorld): string {
  const result = spawnSync(process.execPath, [TSX_CLI, CLEANUP, '--tasks', path.join(k.w, 'tasks.json'), '--logs', path.join(k.w, 'handoff')], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${path.join(k.w, 'gh-stub')}${path.delimiter}${process.env.PATH}` },
  })
  expect(result.stderr).toBe('')
  expect(result.status).toBe(0)
  return result.stdout
}

function launchPreflight(k: KilledWorld): string {
  const result = spawnSync(process.execPath, [TSX_CLI, LAUNCH, '--tasks', path.join(k.w, 'tasks.json')], {
    input: 'no\n',
    encoding: 'utf8',
    env: { ...process.env, PATH: `${path.join(k.w, 'bin')}${path.delimiter}${process.env.PATH}` },
  })
  return `${result.stdout}${result.stderr}`
}

describe('k: ghosts:cleanup cleans up after a killed Ghost', () => {
  it('a killed Ghost leaves a free row, its report set aside and a clean tree, and the launch preflight passes', () => {
    const supervisor = deadPid()
    const k = killedGhostWorld(supervisor)
    const message = `ghosts:cleanup ghost-g1 supervisor ${supervisor} dead`
    const out = cleanupKilled(k)
    const stash = git(k.tree, ['stash', 'list', '--format=%H %gs']).split('\n').find(line => line.endsWith(`: ${message}`))
    expect(stash).toBeDefined()
    expect(out).toContain(`[ghosts:cleanup] ghost-g1 released: supervisor ${supervisor} dead with the row writing; row ghost-g1 free; report moved to ${k.aside}; tree ${k.tree} clean, its changes stashed as ${stash!.slice(0, 7)} "${message}"\n`)
    expect(ghostRowState(readFileSync(k.status, 'utf8'), 'g1')).toBe('free')
    expect(existsSync(k.report)).toBe(false)
    expect(readFileSync(k.aside, 'utf8')).toBe('{"type":"system"}\n')
    expect(git(k.tree, ['status', '--porcelain'])).toBe('')
    expect(git(k.tree, ['stash', 'show', '--name-only', '--include-untracked', stash!.slice(0, 40)]).split('\n').filter(line => line !== '').sort()).toEqual(['sketch-a.ts', 'sketch-b.ts'])
    const launched = launchPreflight(k)
    expect(launched).not.toContain('task g1:')
    expect(launched).toContain('DECISION: open 2 sessions')
  })

  it('a row whose supervisor is alive is refused and unchanged', () => {
    const k = killedGhostWorld(process.pid)
    const statusBefore = readFileSync(k.status, 'utf8')
    const treeBefore = git(k.tree, ['status', '--porcelain'])
    expect(cleanupKilled(k)).toContain(`[ghosts:cleanup] ghost-g1 kept: status.md row ghost-g1 is writing and its supervisor ${process.pid} is alive\n`)
    expect(readFileSync(k.status, 'utf8')).toBe(statusBefore)
    expect(existsSync(k.report)).toBe(true)
    expect(existsSync(k.aside)).toBe(false)
    expect(git(k.tree, ['status', '--porcelain'])).toBe(treeBefore)
    expect(git(k.tree, ['stash', 'list'])).toBe('')
  })

  it('a dead supervisor whose aside name is taken is refused, and the tree, the stash list, the row and both reports are unchanged', () => {
    const supervisor = deadPid()
    const k = killedGhostWorld(supervisor)
    writeFileSync(k.aside, '{"type":"earlier"}\n')
    const statusBefore = readFileSync(k.status, 'utf8')
    const treeBefore = git(k.tree, ['status', '--porcelain'])
    const stashBefore = git(k.tree, ['stash', 'list'])
    expect(cleanupKilled(k)).toContain(`[ghosts:cleanup] ghost-g1 kept: supervisor ${supervisor} dead with the row writing, but the run could not be set aside: ${k.aside} already exists\n`)
    expect(git(k.tree, ['status', '--porcelain'])).toBe(treeBefore)
    expect(git(k.tree, ['stash', 'list'])).toBe(stashBefore)
    expect(readFileSync(k.status, 'utf8')).toBe(statusBefore)
    expect(readFileSync(k.report, 'utf8')).toBe('{"type":"system"}\n')
    expect(readFileSync(k.aside, 'utf8')).toBe('{"type":"earlier"}\n')
  })

  it('a busy row naming no supervisor falls through to cleanupMerged unchanged', () => {
    const k = killedGhostWorld(deadPid())
    const base = git(k.tree, ['rev-parse', 'HEAD']).trim()
    const unnamed = `| ghost-g1 | ${k.tree} | writing | ${base} | 2026-10-09 21:00 | /implement brief-g1.md, session s1 | 2026-10-09 21:00 |`
    writeFileSync(k.status, upsertGhostRow(readFileSync(k.status, 'utf8'), 'g1', unnamed))
    const statusBefore = readFileSync(k.status, 'utf8')
    const treeBefore = git(k.tree, ['status', '--porcelain'])
    const branch = git(k.tree, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()
    expect(cleanupKilled(k)).toContain(`[ghosts:cleanup] ghost-g1 kept: no pull request for ${branch}\n`)
    expect(readFileSync(k.status, 'utf8')).toBe(statusBefore)
    expect(existsSync(k.report)).toBe(true)
    expect(existsSync(k.aside)).toBe(false)
    expect(git(k.tree, ['status', '--porcelain'])).toBe(treeBefore)
    expect(git(k.tree, ['stash', 'list'])).toBe('')
  })
})
