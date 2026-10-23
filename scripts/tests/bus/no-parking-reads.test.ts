import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runAdmit } from '../../../src/commands/intake/admit.js'
import { runMove } from '../../../src/commands/intake/move.js'
import { realAnswererTools } from '../../bus/answerer.js'
import { appendEvent, openBus } from '../../bus/db.js'
import { gitDepthSources } from '../../bus/depth-sources.js'
import { busIntakePorts } from '../../bus/intake.js'
import { busCardBodies, busParkedDepends } from '../../bus/parking-reads.js'
import { launchTasks, queueTask } from '../../bus/queue.js'
import { reduce } from '../../bus/reducer.js'
import { CARD_STARTED, CARD_STOPPED } from '../../core/events.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')
const RUNTIME_ROOTS = ['scripts', 'src']
const TESTS_ROOT = 'scripts/tests'

const INTAKE_SIDE = new Set([
  'src/program.ts',
  'src/commands/intake/index.ts',
  'src/commands/intake/admit.ts',
  'src/commands/intake/move.ts',
  'scripts/bus/intake.ts',
  'scripts/bus/admissions.ts',
  'scripts/bus/card-archive.ts',
  'scripts/bus/close-worker.ts',
  'scripts/bus/import.ts',
])

const PARKING_DIRECTORY_READS = [
  /\bdefaultParking\(/,
  /['"]\.construct['"],\s*['"]parking['"]/,
  /constructDir\(\s*['"]parking['"]\s*\)/,
  /\bparkedCardFile\(/,
  /['"]--parking['"]/,
  /\bPARKING_FLAG\b/,
]

const CARD = '#90 port-card [implement/netwatch/S/cheap/auto] · depends — · blocks —'
const TEXT = `card: ${CARD}\nbranch: feat/port-card\ntouches: src/a.ts\ncontinue: stop\nwho: shift\n\nDo the thing.\n`
const ADMITTED_AT = new Date('2026-10-13T09:00:00.000Z')
const MOVED_AT = new Date('2026-10-13T09:05:00.000Z')
const roots: string[] = []
const locked: string[] = []

afterEach(() => {
  for (const target of locked.splice(0).reverse())
    chmodSync(target, 0o700)
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function runtimeModules(dir: string): string[] {
  return readdirSync(path.join(REPO_ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const relative = path.posix.join(dir, entry.name)
    if (entry.isDirectory())
      return relative === TESTS_ROOT || entry.name === 'node_modules' ? [] : runtimeModules(relative)
    return /\.(?:ts|mjs)$/.test(entry.name) ? [relative] : []
  })
}

interface World { root: string, parking: string, repo: string, bus: string }

function world(name: string): World {
  const root = mkdtempSync(path.join(tmpdir(), `no-parking-reads-${name}-`))
  roots.push(root)
  const repo = path.join(root, 'repo')
  mkdirSync(path.join(repo, 'src'), { recursive: true })
  writeFileSync(path.join(repo, 'src', 'a.ts'), '')
  const parking = path.join(root, 'parking')
  mkdirSync(path.join(parking, 'lane-1'), { recursive: true })
  writeFileSync(path.join(parking, 'lane-1', '90.md'), TEXT)
  return { root, parking, repo, bus: path.join(root, 'bus.db') }
}

function admitAndMove(w: World, between: () => void = () => {}): void {
  const db = openBus(w.bus)
  try {
    const ports = busIntakePorts(db, 's1')
    expect(runAdmit({ file: path.join(w.parking, 'lane-1', '90.md'), dir: w.repo, dryRun: false, autoConfirm: false, parkingRoot: w.parking, events: ports.cardEvents, cardStates: ports.cardStates, admissions: ports.cardAdmissions }, () => ADMITTED_AT).status).toBe('admitted')
    reduce(db)
    between()
    expect(runMove({ move: '#90', to: 'lane-2', draft: undefined, taken: undefined, admit: undefined, parking: w.parking, events: ports.cardEvents }, () => MOVED_AT).status).toBe('moved')
    reduce(db)
  }
  finally {
    db.close()
  }
}

function unreadable(file: string): void {
  for (const target of [file, path.dirname(file)]) {
    chmodSync(target, 0o000)
    locked.push(target)
  }
}

function tasksDump(bus: string): string {
  const db = openBus(bus)
  try {
    for (const task of launchTasks(db))
      queueTask(db, MOVED_AT.toISOString(), task)
    reduce(db)
    return JSON.stringify(db.prepare('SELECT * FROM tasks ORDER BY task_key').all())
  }
  finally {
    db.close()
  }
}

describe('no runtime reader opens the parking directory; the card body comes from the bus', () => {
  it('no runtime module outside intake reads the parking directory', () => {
    const readers = RUNTIME_ROOTS.flatMap(runtimeModules)
      .filter(file => !INTAKE_SIDE.has(file))
      .filter((file) => {
        const source = readFileSync(path.join(REPO_ROOT, file), 'utf8')
        return PARKING_DIRECTORY_READS.some(pattern => pattern.test(source))
      })
    expect(readers).toEqual([])
    for (const file of INTAKE_SIDE)
      expect(statSync(path.join(REPO_ROOT, file)).isFile()).toBe(true)
  })

  it('a card file moved to another lane mid-session does not stop the card and no reader opened it', () => {
    const w = world('moved')
    admitAndMove(w, () => {
      const db = openBus(w.bus)
      try {
        appendEvent(db, { ts: ADMITTED_AT.toISOString(), type: CARD_STARTED, actor: 'policy', cardId: 90, pr: null, head: null, dedupeKey: `${CARD_STARTED}:90`, payload: {}, legacy: false })
        reduce(db)
      }
      finally {
        db.close()
      }
    })
    unreadable(path.join(w.parking, 'lane-2', '90.md'))

    expect(busCardBodies(w.bus)(90)).toBe(TEXT)
    expect(realAnswererTools(w.bus).cardText(90)).toBe(TEXT)
    expect(gitDepthSources(w.repo, path.join(w.root, 'morse.jsonl'), busCardBodies(w.bus)).scope(90)).toMatchObject({ touches: ['src/a.ts'] })
    expect(busParkedDepends(w.bus).get(90)).toEqual([])
    const db = openBus(w.bus)
    try {
      expect(db.prepare('SELECT COUNT(*) AS stops FROM events WHERE type = ? AND card_id = 90').get(CARD_STOPPED)).toEqual({ stops: 0 })
      expect((db.prepare('SELECT state FROM cards WHERE card_id = 90').get() as { state: string }).state).not.toBe('stopped')
    }
    finally {
      db.close()
    }
  })

  it('replaying the log in a copy of the repository at another path dumps byte-identical tasks', () => {
    const [first, second] = [world('first'), world('second')]
    expect(first.root).not.toBe(second.root)
    admitAndMove(first)
    admitAndMove(second)
    const dump = tasksDump(first.bus)
    expect(dump).toContain('launch:90:')
    expect(dump).not.toContain(first.root)
    expect(tasksDump(second.bus)).toBe(dump)
  })
})
