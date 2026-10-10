import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { afterEach, describe, expect, it } from 'vitest'
import { parkingFileText } from '../../../src/card/parking.js'
import { killQuietly, psPgid, shellWord, ShiftCardStarter, spawnDetached } from '../../bus/launch-starter.js'

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
  for (let attempt = 0; attempt < 400 && !(existsSync(file) && readFileSync(file, 'utf8') !== ''); attempt += 1)
    await sleep(50)
  return existsSync(file) ? readFileSync(file, 'utf8') : ''
}

async function exited(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 400 && alive(pid); attempt += 1)
    await sleep(50)
}

function launchWorld(claudeExit: number) {
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
  mkdirSync(path.join(parking, 'lane-x'), { recursive: true })
  writeFileSync(path.join(parking, 'lane-x', `${CARD_ID}.md`), parkingFileText({ card: CARD_LINE, branch: BRANCH, touches: ['scripts/bus/**'], continue: 'stop', who: 'shift', body: 'Do the card.' }))

  const bin = path.join(root, 'bin')
  mkdirSync(bin)
  const ghArgs = path.join(root, 'gh-args.txt')
  script(path.join(bin, 'gh'), `#!/bin/sh\nif [ "$1 $2" = "pr list" ]; then echo '[]'; exit 0; fi\nif [ "$1 $2" = "pr create" ]; then printf '%s\\n' "$@" > '${ghArgs}.tmp'; mv '${ghArgs}.tmp' '${ghArgs}'; echo https://github.com/x/y/pull/77; exit 0; fi\nexit 1\n`)
  const claude = script(path.join(root, 'claude-stub.sh'), `#!/bin/sh\ncat > /dev/null\nprintf 'green\\n' > x.txt\nexit ${claudeExit}\n`)

  const treePr = `${shellWord(path.join(REPO, 'node_modules', '.bin', 'tsx'))} ${shellWord(path.join(REPO, 'scripts', 'shift', 'tree-pr-cli.ts'))}`
  const starter = new ShiftCardStarter(
    { parking, launchDir: path.join(root, 'launch'), header: 'card {{card}} in {{worktree}}, report {{report}}\n\n', env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` }, claude, treePr },
    {
      read: file => existsSync(file) ? readFileSync(file, 'utf8') : null,
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
