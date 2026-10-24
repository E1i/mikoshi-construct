import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { boardProjection } from '../scripts/bus/board-page.js'
import { BOARD_FILE } from '../scripts/bus/board.js'
import { appendEvent, openBus } from '../scripts/bus/db.js'
import { keepDryRun } from '../scripts/bus/dry-run-record.js'
import { reviewsDir } from '../scripts/bus/review-worker.js'
import { gitCode, recordStarted, switchCommand } from '../scripts/bus/supervisor.js'
import { realRequestTools } from '../scripts/bus/window-request-tools.js'
import { switchedOn } from '../scripts/bus/workers.js'
import { BUS_DB_VARIABLE, busDirOf, busPathOf, machineBusPath, pinBus, repoIdOf, repoSlugOf, repoSlugOfUrl } from '../scripts/core/bus-path.js'
import { CARD_ADMITTED } from '../scripts/core/events.js'
import { ghInRepositoryOf, noGitRemoteReason } from '../scripts/shift/places.js'
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
  'scripts/bus/window-request-tools.ts',
  'scripts/ghosts/task-close.ts',
  'src/commands/board/bus.ts',
  'src/commands/board/index.ts',
  'src/program.ts',
]
const OWNER_NAMES = [/E1i/, /projects\/mikoshi-construct/, /'projects', 'mikoshi-construct'/]
const MACHINE_BUS_PLACES = [/'\.construct', 'bus'/, /\.construct\/bus/, /'bus\.db'/, /'dry-run-reviews'/]
const SUPERVISOR_ENTRY = path.join(ROOT, 'scripts/bus/supervisor.ts')
const TSX_LOADER = pathToFileURL(path.join(ROOT, 'node_modules/tsx/dist/esm/index.mjs')).href
const SYSTEM_PATH = [path.dirname(process.execPath), '/usr/bin', '/bin'].join(path.delimiter)
const FAKE_TOKEN = ['fake', 'gh', 'token', 'factoryOffOwnerMachine'].join('-')
const TOKEN_LITERAL_IN_MAIN_HISTORY = ['gho', 'factoryOffOwnerMachine0123456789abcdef'].join('_')
const GITLEAKS_GITHUB_TOKEN = /(?:gh[pousr]_[0-9a-z]{36}|github_pat_\w{82})/i
const GITLEAKS_CONFIG = path.join(ROOT, '.gitleaks.toml')
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

  it('points gh at the repository the remote of the given directory names', () => {
    const repo = foreignRepo(scratch, 'git@github.com:acme/widgets.git')
    const calls: string[][] = []
    const gh = ghInRepositoryOf(repo, (args) => {
      calls.push(args)
      return { kind: 'ran', stdout: '{}', attempts: 1 }
    })
    expect(gh(['pr', 'view', '7', '--json', 'body']).kind).toBe('ran')
    expect(calls).toEqual([['pr', 'view', '7', '--json', 'body', '-R', 'acme/widgets']])
  })

  it('refuses to call gh with a clear reason where no git remote names the repository', () => {
    const repo = foreignRepo(scratch, null)
    const calls: string[][] = []
    const read = ghInRepositoryOf(repo, (args) => {
      calls.push(args)
      return { kind: 'ran', stdout: '{}', attempts: 1 }
    })(['issue', 'list'])
    expect(read).toMatchObject({ kind: 'failed', reason: noGitRemoteReason(repo) })
    expect(noGitRemoteReason(repo)).toContain('no git remote')
    expect(calls).toEqual([])
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

  it('finds the same bus from a subdirectory of a worktree as from the clone', () => {
    const repo = foreignRepo(scratch, 'git@github.com:acme/widgets.git')
    const tree = path.join(scratch, 'tree')
    git(repo, 'worktree', 'add', '-q', tree)
    const deep = path.join(tree, 'scripts', 'bus')
    mkdirSync(deep, { recursive: true })
    expect(busPathOf(env, home, deep)).toBe(busPathOf(env, home, repo))
  })

  it('a bus pinned by the supervisor holds for a worker started outside any repository', () => {
    const repo = foreignRepo(scratch, 'git@github.com:acme/widgets.git')
    const outside = path.join(scratch, 'outside')
    mkdirSync(outside)
    const pinned: NodeJS.ProcessEnv = {}
    const busPath = pinBus(pinned, home, repo)
    expect(busPath).toBe(path.join(home, '.construct', 'acme--widgets', 'bus.db'))
    expect(busPathOf(env, home, outside)).not.toBe(busPath)
    expect(busPathOf(pinned, home, outside)).toBe(busPath)
  })

  it('the supervisor started in a subdirectory of the repository switches the workers of its bus', () => {
    const repo = foreignRepo(scratch, 'git@github.com:acme/widgets.git')
    const deep = path.join(repo, 'scripts')
    mkdirSync(deep)
    const run = spawnSync(process.execPath, ['--import', TSX_LOADER, SUPERVISOR_ENTRY, '--on', 'review'], { cwd: deep, env: { HOME: home, PATH: SYSTEM_PATH, TMPDIR: tmpdir() }, encoding: 'utf8' })
    expect(run.status, run.stderr).toBe(0)
    expect(switchedOn(path.join(home, '.construct', 'acme--widgets', 'bus'))).toEqual(['review'])
  })

  it('the window request reads a dry run where the review worker of the same bus keeps it', () => {
    const repo = foreignRepo(scratch, 'git@github.com:acme/widgets.git')
    const busPath = busPathOf(env, home, repo)
    admitCard(busPath, 4)
    const dir = reviewsDir(busDirOf(busPath), { kind: 'dry-run', pr: 12 })
    mkdirSync(dir, { recursive: true })
    const record = { pr: 12, head: 'a'.repeat(40) }
    keepDryRun(dir)('session-1', record)
    const db = openBus(busPath)
    try {
      expect(realRequestTools(db, busPath, repo, env, home).dryRunOf('session-1')).toEqual(record)
    }
    finally {
      db.close()
    }
  })

  it(`lets ${BUS_DB_VARIABLE} name the bus outright`, () => {
    const repo = foreignRepo(scratch, 'git@github.com:acme/widgets.git')
    expect(busPathOf({ [BUS_DB_VARIABLE]: path.join(scratch, 'named.db') }, home, repo)).toBe(path.join(scratch, 'named.db'))
  })
})

describe('the gh token stays with gh', () => {
  it('the launchd job starts the bus in the factory checkout with no token, and names the variable it lacks', () => {
    const shellLine = [...readFileSync(PLIST, 'utf8').matchAll(/<string>([^<]*)<\/string>/g)].map(match => match[1]!).at(-1)!.replaceAll('&gt;', '>').replaceAll('&lt;', '<').replaceAll('&amp;', '&')
    const factory = path.join(scratch, 'factory')
    const bin = path.join(home, '.local', 'bin')
    mkdirSync(factory)
    mkdirSync(bin, { recursive: true })
    const calls = path.join(scratch, 'calls')
    writeFileSync(path.join(bin, 'pnpm'), `#!/bin/sh\necho "$(pwd) $* token=\${GH_TOKEN:-none}" >> "${calls}"\n`, { mode: 0o755 })
    const started = spawnSync('/bin/sh', ['-c', shellLine], { env: { HOME: home, CONSTRUCT_FACTORY_DIR: factory }, encoding: 'utf8' })
    expect(started.status).toBe(0)
    expect(readFileSync(calls, 'utf8')).toBe(`${factory} --silent bus:bg token=none\n`)

    const unset = spawnSync('/bin/sh', ['-c', shellLine], { env: { HOME: home }, encoding: 'utf8' })
    expect(unset.status).not.toBe(0)
    expect(readFileSync(path.join(home, '.construct', 'dev.mikoshi.bus.log'), 'utf8')).toContain('CONSTRUCT_FACTORY_DIR')
  })

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

  it('no test source spells a token that gitleaks reads as a GitHub token', () => {
    const spelling = filesUnder(path.join(ROOT, 'tests')).filter(file => file.endsWith('.ts') && GITLEAKS_GITHUB_TOKEN.test(readFileSync(file, 'utf8')))
    expect(spelling).toEqual([])
  })

  it('the fake token does not match the gitleaks GitHub token rule', () => {
    expect(FAKE_TOKEN).not.toMatch(GITLEAKS_GITHUB_TOKEN)
    expect(TOKEN_LITERAL_IN_MAIN_HISTORY).toMatch(GITLEAKS_GITHUB_TOKEN)
  })

  it('the gitleaks allowlist names only the fake token literal main already carries', () => {
    const config = readFileSync(GITLEAKS_CONFIG, 'utf8')
    const regexes = [...config.matchAll(/^regexes = \[(.*)\]$/gm)].flatMap(match => [...match[1]!.matchAll(/'''([^']*)'''/g)].map(literal => literal[1]))
    expect(regexes).toEqual([TOKEN_LITERAL_IN_MAIN_HISTORY])
    expect(config).not.toMatch(/^\s*(?:commits|stopwords)\s*=/m)
    expect([...config.matchAll(/^paths = (.*)$/gm)].map(match => match[1])).toEqual([String.raw`[ '''(^|/)construct\.json$''' ]`])
  })
})

describe('factory sources', () => {
  it('no factory source names E1i or the owner checkout path', () => {
    const named = FACTORY_FILES.filter(file => OWNER_NAMES.some(name => name.test(readFileSync(path.join(ROOT, file), 'utf8'))))
    expect(named).toEqual([])
  })

  it('no factory source but the bus path module builds a bus place of its own, so the rest of home is owner tooling', () => {
    const building = FACTORY_FILES.filter(file => file !== 'scripts/core/bus-path.ts' && MACHINE_BUS_PLACES.some(place => place.test(readFileSync(path.join(ROOT, file), 'utf8'))))
    expect(building).toEqual([])
  })
})
