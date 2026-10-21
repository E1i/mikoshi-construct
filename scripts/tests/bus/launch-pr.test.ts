import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { parkingFileText } from '../../../src/card/parking.js'
import { textSha } from '../../../src/card/text-sha.js'
import { appendEvent, BUS_DB_VARIABLE, openBus } from '../../bus/db.js'
import { CARD_ADMITTED } from '../../bus/launch-candidates.js'
import { killQuietly, psPgid, shellWord, ShiftCardStarter, spawnDetached } from '../../bus/launch-starter.js'
import { busCardBodies } from '../../bus/launch-worker.js'
import { reduce } from '../../bus/reducer.js'
import { sessionEnv } from '../../ghosts/session.js'
import { renderPrompt } from '../../shift/prompt.js'
import { waitFor } from '../wait-for.js'

const ARRIVAL_GUARD_MS = 25_000

const roots: string[] = []
const groups: number[] = []

afterEach(() => {
  for (const pgid of groups.splice(0)) {
    try {
      process.kill(-pgid, 'SIGKILL')
    }
    catch {}
  }
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

const REPO = process.cwd()
const CARD_ID = 951
const BRANCH = `feat/card-${CARD_ID}`
const CARD_LINE = `#${CARD_ID} a-card [implement/netwatch/M/cheap/auto] · depends — · blocks —`

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function script(file: string, text: string): string {
  writeFileSync(file, text)
  chmodSync(file, 0o755)
  return file
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  }
  catch {
    return false
  }
}

async function settledFile(file: string): Promise<string> {
  await waitFor(() => existsSync(file) && readFileSync(file, 'utf8') !== '', () => `the gh stub to write ${file}`, ARRIVAL_GUARD_MS)
  return readFileSync(file, 'utf8')
}

async function exited(pid: number): Promise<void> {
  await waitFor(() => !alive(pid), () => `process ${pid} to exit`, ARRIVAL_GUARD_MS)
}

function launchWorld(claudeExit: number, report = '') {
  const root = mkdtempSync(path.join(tmpdir(), 'bus-launch-pr-'))
  roots.push(root)
  const origin = path.join(root, 'origin.git')
  const seed = path.join(root, 'seed')
  const worktree = path.join(root, `mc-${CARD_ID}`)
  git(root, ['init', '-q', '--bare', '-b', 'main', origin])
  git(root, ['init', '-q', '-b', 'main', seed])
  writeFileSync(path.join(seed, 'README.md'), 'seed\n')
  git(seed, ['add', 'README.md'])
  git(seed, ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'seed'])
  git(seed, ['push', '-q', origin, 'main'])
  git(root, ['clone', '-q', origin, worktree])
  git(worktree, ['config', 'user.name', 't'])
  git(worktree, ['config', 'user.email', 't@t'])
  git(worktree, ['config', 'commit.gpgsign', 'false'])
  git(worktree, ['checkout', '-q', '-b', BRANCH])

  const parking = path.join(root, 'parking')
  const cardText = parkingFileText({ card: CARD_LINE, branch: BRANCH, touches: ['scripts/bus/**', 'x.txt'], continue: 'stop', who: 'shift', body: 'Do the card.\nPath (D-76): cheap, a fixture card the stub closes in one run' })
  const busPath = path.join(root, 'bus.db')
  const db = openBus(busPath)
  try {
    appendEvent(db, { ts: '2026-10-21T00:00:00.000Z', type: CARD_ADMITTED, actor: 'policy', cardId: CARD_ID, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${CARD_ID}`, payload: { lane: 'lane-x', decision: 'auto', contour: 'cheap', depends: [], admission: `admission-${CARD_ID}`, text: cardText, textSha: textSha(cardText) }, legacy: false })
    reduce(db)
  }
  finally {
    db.close()
  }

  const bin = path.join(root, 'bin')
  mkdirSync(bin)
  const ghArgs = path.join(root, 'gh-args.txt')
  script(path.join(bin, 'gh'), `#!/bin/sh\nif [ "$1 $2" = "pr list" ]; then echo '[]'; exit 0; fi\nif [ "$1 $2" = "pr create" ]; then printf '%s\\n' "$@" > '${ghArgs}.tmp'; mv '${ghArgs}.tmp' '${ghArgs}'; echo https://github.com/x/y/pull/77; exit 0; fi\nexit 1\n`)
  const launchDir = path.join(root, 'launch')
  const writeReport = report === '' ? '' : `printf '%s\\n' ${shellWord(report)} > ${shellWord(path.join(launchDir, `report-${CARD_ID}.md`))}\n`
  const claude = script(path.join(root, 'claude-stub.sh'), `#!/bin/sh\ncat > /dev/null\nprintf 'green\\n' > x.txt\n${writeReport}exit ${claudeExit}\n`)

  const treePr = `${shellWord(path.join(REPO, 'node_modules', '.bin', 'tsx'))} ${shellWord(path.join(REPO, 'scripts', 'shift', 'tree-pr-cli.ts'))}`
  const env = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`, [BUS_DB_VARIABLE]: busPath }
  const starter = new ShiftCardStarter(
    { parking, launchDir, claude, treePr },
    {
      read: busCardBodies(busPath),
      cut: () => worktree,
      base: tree => git(tree, ['rev-parse', 'HEAD']).trim(),
      spawnDetached: (run) => {
        const pid = spawnDetached(run)
        groups.push(pid)
        return pid
      },
      pgidOf: psPgid,
      kill: killQuietly,
      uuid: () => `session-${CARD_ID}`,
      envOf: id => sessionEnv(env, id),
      prompt: (task, at) => renderPrompt('card {{card}} in {{worktree}}, report {{report}}\n\n', task, at),
      changedPaths: () => [],
      readReport: () => null,
    },
  )
  return { origin, worktree, ghArgs, start: () => starter.start({ cardId: CARD_ID, lane: 'lane-x' }) }
}

describe('a card the bus launches', () => {
  it('a launched card reaches an open PR with no hand commit', async () => {
    const world = launchWorld(0)
    expect(world.start()).toMatchObject({ kind: 'started' })

    const args = (await settledFile(world.ghArgs)).split('\n')
    expect(args.slice(0, 2)).toEqual(['pr', 'create'])
    expect(args[args.indexOf('--body') + 1]).toBe(CARD_LINE)
    expect(git(world.origin, ['show', `${BRANCH}:x.txt`])).toBe('green\n')
    expect(git(world.worktree, ['status', '--porcelain'])).toBe('')
  })

  it('a launched card\'s PR body carries the matrix count line of its session report', async () => {
    const world = launchWorld(0, 'verification: run\n\n■ 2 □ 0 · 1')
    expect(world.start()).toMatchObject({ kind: 'started' })

    const args = await settledFile(world.ghArgs)
    expect(args.split('\n').slice(0, 2)).toEqual(['pr', 'create'])
    const body = args.slice(args.indexOf('--body\n') + '--body\n'.length).trimEnd().split('\n')
    expect({ first: body[0], last: body.slice(-2) }).toEqual({ first: CARD_LINE, last: ['', '■ 2 □ 0 · 1'] })
  })

  it('a launched session that exits non-zero leaves its tree uncommitted', async () => {
    const world = launchWorld(3)
    const start = world.start()
    expect(start).toMatchObject({ kind: 'started' })
    if (start.kind === 'started')
      await exited(start.card.pid)

    expect(git(world.worktree, ['status', '--porcelain'])).toBe('?? x.txt\n')
    expect(git(world.origin, ['branch', '--list', BRANCH])).toBe('')
    expect(existsSync(world.ghArgs)).toBe(false)
  })
})
