import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { boardProjection } from '../scripts/bus/board-page.js'
import { BOARD_FILE } from '../scripts/bus/board.js'
import { appendEvent, openBus } from '../scripts/bus/db.js'
import { gitCode, recordStarted, switchCommand } from '../scripts/bus/supervisor.js'
import { BUS_DB_VARIABLE, busDirOf, busPathOf, machineBusPath, repoIdOf, repoSlugOf, repoSlugOfUrl } from '../scripts/core/bus-path.js'
import { CARD_ADMITTED } from '../scripts/core/events.js'
import { NO_GIT_REMOTE, REPO } from '../scripts/shift/places.js'
import { busReaderAt } from '../src/commands/board/bus.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PLIST = path.join(ROOT, 'scripts/bus/launchd/dev.mikoshi.bus.plist')
const FACTORY_FILES = [
  'scripts/core/bus-path.ts',
  'scripts/shift/places.ts',
  'scripts/bus/launchd/dev.mikoshi.bus.plist',
  'scripts/bus/board-page.ts',
  'scripts/bus/run.ts',
  'scripts/bus/supervisor.ts',
  'scripts/bus/answer-worker.ts',
  'scripts/bus/close-worker.ts',
  'scripts/bus/restart-worker.ts',
  'scripts/bus/review-bg.ts',
  'scripts/bus/review-worker.ts',
  'scripts/bus/launch-worker.ts',
  'src/commands/board/bus.ts',
  'src/commands/board/index.ts',
  'src/program.ts',
]
const OWNER_NAMES = [/E1i/, /projects\/mikoshi-construct/, /'projects', 'mikoshi-construct'/, /homedir\(\), '\.construct', 'bus'/]
const FAKE_TOKEN = 'gho_factoryOffOwnerMachine0123456789abcdef'
const TICK_MS = 1000
const NOW = new Date('2026-10-24T12:00:00.000Z')

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
}

function foreignRepo(parent: string, remote: string | null): string {
  const repo = path.join(parent, `repo-${Math.random().toString(36).slice(2)}`)
  mkdirSync(repo, { recursive: true })
  git(repo, 'init', '-q', '-b', 'main')
  writeFileSync(path.join(repo, 'README.md'), '# foreign\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-q', '-m', 'first')
  if (remote !== null)
    git(repo, 'remote', 'add', 'origin', remote)
  return repo
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const file = path.join(dir, name)
    return statSync(file).isDirectory() ? filesUnder(file) : [file]
  })
}

function admitCard(busPath: string, cardId: number): void {
  mkdirSync(path.dirname(busPath), { recursive: true })
  const db = openBus(busPath)
  try {
    appendEvent(db, { ts: NOW.toISOString(), type: CARD_ADMITTED, actor: 'owner', cardId, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${cardId}`, payload: { card: cardId }, legacy: false })
  }
  finally {
    db.close()
  }
}

function eventCards(busPath: string): number[] {
  const db = openBus(busPath)
  try {
    return (db.prepare('SELECT card_id FROM events WHERE card_id IS NOT NULL').all() as { card_id: number }[]).map(row => row.card_id)
  }
  finally {
    db.close()
  }
}

let scratch: string
let home: string
const env: NodeJS.ProcessEnv = {}

beforeEach(() => {
  scratch = mkdtempSync(path.join(tmpdir(), 'factory-off-owner-'))
  home = path.join(scratch, 'home')
  mkdirSync(home)
})

afterEach(() => {
  delete process.env.GH_TOKEN
})

describe('the repository comes from the git remote of the current repository', () => {
  it('reads owner and repo from an ssh, an https and a dotless remote', () => {
    expect(repoSlugOfUrl('git@github.com:acme/widgets.git')).toBe('acme/widgets')
    expect(repoSlugOfUrl('https://github.com/acme/widgets.git')).toBe('acme/widgets')
    expect(repoSlugOfUrl('https://github.com/acme/widgets')).toBe('acme/widgets')
  })

  it('reads the same repository from a worktree of the clone', () => {
    const repo = foreignRepo(scratch, 'git@github.com:acme/widgets.git')
    const tree = path.join(scratch, 'tree')
    git(repo, 'worktree', 'add', '-q', tree)
    expect(repoSlugOf(tree)).toBe('acme/widgets')
    expect(repoIdOf(tree)).toBe(repoIdOf(repo))
  })

  it('takes the shift repository from this checkout, not a constant', () => {
    expect(REPO).toBe(repoSlugOf(process.cwd()) ?? NO_GIT_REMOTE)
  })

  it('gives a repository without a remote a local id of its own', () => {
    const one = foreignRepo(scratch, null)
    const two = foreignRepo(scratch, null)
    expect(repoIdOf(one)).toMatch(/^local--repo-/)
    expect(repoIdOf(one)).not.toBe(repoIdOf(two))
  })
})

describe('per-repository bus home', () => {
  it('the bus and the board of a foreign repository live under its repo id from git remote', () => {
    const widgets = foreignRepo(scratch, 'git@github.com:acme/widgets.git')
    const gadgets = foreignRepo(scratch, 'https://github.com/other/gadgets.git')
    const widgetsBus = busPathOf(env, home, widgets)
    const gadgetsBus = busPathOf(env, home, gadgets)
    expect(widgetsBus).toBe(path.join(home, '.construct', 'acme--widgets', 'bus.db'))
    expect(gadgetsBus).toBe(path.join(home, '.construct', 'other--gadgets', 'bus.db'))
    expect(busDirOf(widgetsBus)).toBe(path.join(home, '.construct', 'acme--widgets', 'bus'))

    admitCard(widgetsBus, 7)
    admitCard(gadgetsBus, 9)
    const db = openBus(widgetsBus)
    try {
      const board = boardProjection(db, widgetsBus, TICK_MS, undefined, path.join(scratch, 'no-handoff.md'))
      board.project(NOW)
      expect(board.file).toBe(path.join(home, '.construct', 'acme--widgets', BOARD_FILE))
      expect(statSync(board.file).isFile()).toBe(true)
    }
    finally {
      db.close()
    }
    expect(busReaderAt(widgetsBus)().status).toBe('read')
    expect(eventCards(widgetsBus)).toEqual([7])
    expect(eventCards(gadgetsBus)).toEqual([9])
  })

  it('keeps reading a machine-wide bus from before per-repository homes until the repository has its own', () => {
    const repo = foreignRepo(scratch, 'git@github.com:acme/widgets.git')
    admitCard(machineBusPath(home), 1)
    expect(busPathOf(env, home, repo)).toBe(machineBusPath(home))
    admitCard(path.join(home, '.construct', 'acme--widgets', 'bus.db'), 2)
    expect(busPathOf(env, home, repo)).toBe(path.join(home, '.construct', 'acme--widgets', 'bus.db'))
  })

  it(`lets ${BUS_DB_VARIABLE} name the bus outright`, () => {
    const repo = foreignRepo(scratch, 'git@github.com:acme/widgets.git')
    expect(busPathOf({ [BUS_DB_VARIABLE]: path.join(scratch, 'named.db') }, home, repo)).toBe(path.join(scratch, 'named.db'))
  })
})

describe('the gh token stays with gh', () => {
  it('the token of the current gh appears in no file under the construct home and in no bus event', () => {
    const plist = readFileSync(PLIST, 'utf8')
    expect(plist).not.toMatch(/GH_TOKEN|gh auth token/)

    process.env.GH_TOKEN = FAKE_TOKEN
    const repo = foreignRepo(scratch, 'git@github.com:acme/widgets.git')
    const busPath = busPathOf(env, home, repo)
    const busDir = busDirOf(busPath)
    mkdirSync(busDir, { recursive: true })
    admitCard(busPath, 3)
    const db = openBus(busPath)
    const log: string[] = []
    try {
      recordStarted(db, NOW.toISOString(), gitCode(repo), line => log.push(line))
      expect(switchCommand(busDir, 'review', true).exitCode).toBe(0)
      boardProjection(db, busPath, TICK_MS, undefined, path.join(scratch, 'no-handoff.md')).project(NOW)
      const events = db.prepare('SELECT type, actor, dedupe_key, payload FROM events').all()
      expect(events.length).toBeGreaterThan(1)
      expect(JSON.stringify(events)).not.toContain(FAKE_TOKEN)
    }
    finally {
      db.close()
    }
    writeFileSync(path.join(busDir, 'supervisor.log'), `${log.join('\n')}\n`)
    const files = filesUnder(path.join(home, '.construct'))
    expect(files.some(file => file.endsWith(BOARD_FILE))).toBe(true)
    expect(files.filter(file => readFileSync(file).includes(FAKE_TOKEN))).toEqual([])
  })
})

describe('factory sources', () => {
  it('no factory source names E1i or the owner checkout path', () => {
    const named = FACTORY_FILES.filter(file => OWNER_NAMES.some(name => name.test(readFileSync(path.join(ROOT, file), 'utf8'))))
    expect(named).toEqual([])
  })
})
