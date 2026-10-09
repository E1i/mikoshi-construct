import type { Projection, StateDeps, StatePlaces, View } from '../../state/index.js'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { HANDOFF_DIR_VARIABLE } from '../../board/run.js'
import { HANDOFF_FIELDS } from '../../ghosts/handoff-check.js'
import { buildView, CONSTRUCT_HOME_VARIABLE, projectionPath, readView, renderViews, runState, SCHEMA_VERSION, sealOf, stateFindings, statePlaces, storedProjection, VIEWS } from '../../state/index.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')
const STATE_SCRIPT = path.join(REPO_ROOT, 'scripts', 'state', 'index.ts')
const DECISIONS = '# Owner decisions\n\n- D-1 · 2026-10-01 — the first decision · card #11\n- D-2 · 2026-10-02 — a decision still in force\n'
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function card(id: number, header = 'who: shift'): string {
  return `card: #${id} task-${id} [implement/ghosts/S/cheap/owner] · depends — · blocks —\nbranch: feat/${id}\ntouches: scripts/${id}/**\n${header}\n\ndo ${id}\n`
}

function world(): StatePlaces {
  const home = realpathSync(mkdtempSync(path.join(tmpdir(), 'state-world-')))
  roots.push(home)
  const places = statePlaces(home)
  mkdirSync(path.join(places.parking, 'lane-1'), { recursive: true })
  mkdirSync(path.dirname(places.journal), { recursive: true })
  writeFileSync(places.decisions, DECISIONS)
  writeFileSync(path.join(places.parking, 'lane-1', '11.md'), card(11))
  writeFileSync(path.join(places.parking, 'lane-1', '12.md'), card(12))
  writeFileSync(path.join(places.parking, 'lane-1', '13.md'), card(13, 'who: shift\npriority: p0'))
  writeFileSync(path.join(places.parking, 'lane-1', '14.md'), card(14))
  writeFileSync(places.journal, [
    { event: 'path', task: '11', path: 'cheap', started: '2026-10-09T10:00:00Z', branch: 'feat/11' },
    { event: 'merge', task: '11', pr: 1 },
    { event: 'path', task: '12', path: 'ladder', started: '2026-10-09T11:00:00Z', branch: 'feat/12' },
  ].map(line => `${JSON.stringify(line)}\n`).join(''))
  return places
}

interface Seen {
  out: string[]
  err: string[]
}

function deps(places: StatePlaces, seen: Seen = { out: [], err: [] }): StateDeps {
  return {
    places,
    cwd: places.home,
    now: () => new Date('2026-10-10T08:00:00.000Z'),
    pid: process.pid,
    alive: () => false,
    out: line => seen.out.push(line),
    err: line => seen.err.push(line),
  }
}

function stateEvents(places: StatePlaces): Array<Record<string, unknown>> {
  return readFileSync(places.journal, 'utf8').trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>).filter(line => line.event === 'state')
}

function bumpMtime(file: string): void {
  const later = new Date(Date.now() + 10_000)
  utimesSync(file, later, later)
}

function writer(places: StatePlaces, args: string[]): Promise<{ code: number | null, stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', STATE_SCRIPT, ...args], {
      cwd: REPO_ROOT,
      env: { ...process.env, [CONSTRUCT_HOME_VARIABLE]: places.home, [HANDOFF_DIR_VARIABLE]: path.dirname(places.journal) },
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    let stderr = ''
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('close', code => resolve({ code, stderr }))
  })
}

describe('pnpm state views', () => {
  it('reads the decisions in force, the parked cards neither settled nor in flight, and the started cards not settled', () => {
    const places = world()
    expect(readView('decisions', places).lines).toEqual(['- D-1 · 2026-10-01 — the first decision · card #11', '- D-2 · 2026-10-02 — a decision still in force'])
    expect(readView('queue', places).lines).toEqual([
      '#13 task-13 [implement/ghosts/S/cheap/owner] · depends — · blocks — · who: shift · p0',
      '#14 task-14 [implement/ghosts/S/cheap/owner] · depends — · blocks — · who: shift',
    ])
    expect(readView('inflight', places).lines).toEqual(['#12 ladder since 2026-10-09T11:00:00Z · feat/12'])
  })

  it('stores each view with its schema version and the fingerprint of its source, and serves it again without a rebuild', () => {
    const places = world()
    for (const view of VIEWS) {
      expect(readView(view, places).rebuilt).toBe(true)
      expect(storedProjection(view, places)).toMatchObject({ schema: SCHEMA_VERSION, view, fingerprint: { journalOffset: readFileSync(places.journal).length } })
      expect(readView(view, places)).toEqual({ lines: buildView(view, places), rebuilt: false })
    }
  })

  it.each<[string, View, (places: StatePlaces) => void]>([
    ['a source changed under it', 'decisions', (places) => {
      writeFileSync(places.decisions, `${DECISIONS}- D-3 · 2026-10-03 — written by hand\n`)
      bumpMtime(places.decisions)
    }],
    ['a journal that grew', 'inflight', places => writeFileSync(places.journal, `${readFileSync(places.journal, 'utf8')}${JSON.stringify({ event: 'path', task: '14', path: 'cheap', started: '2026-10-10T07:00:00Z' })}\n`)],
    ['another schema version, sealed as its own', 'queue', (places) => {
      const file = projectionPath('queue', places)
      const other = { ...JSON.parse(readFileSync(file, 'utf8')) as Projection, schema: SCHEMA_VERSION + 1, lines: ['#99 from another schema'] }
      writeFileSync(file, JSON.stringify({ ...other, seal: sealOf(other) }))
    }],
    ['a damaged fingerprint', 'decisions', (places) => {
      const file = projectionPath('decisions', places)
      writeFileSync(file, readFileSync(file, 'utf8').replace(/"sources": "[0-9a-f]{4}/, '"sources": "0000'))
    }],
    ['damaged lines', 'queue', (places) => {
      const file = projectionPath('queue', places)
      writeFileSync(file, readFileSync(file, 'utf8').replace('task-14', 'task-99'))
    }],
    ['a file that is not JSON', 'inflight', places => writeFileSync(projectionPath('inflight', places), '{"schema":')],
  ])('rebuilds on a broken fingerprint: %s', (_, view, breakIt) => {
    const places = world()
    readView(view, places)
    breakIt(places)
    const reading = readView(view, places)
    expect(reading).toEqual({ lines: buildView(view, places), rebuilt: true })
    expect(storedProjection(view, places)?.lines).toEqual(reading.lines)
    expect(stateFindings(places)).toEqual([])
  })

  it('renders the three views under their command names for a prompt', () => {
    const rendered = renderViews(world())
    expect(rendered.split('\n').filter(line => line.startsWith('## '))).toEqual(VIEWS.map(view => `## pnpm state ${view}`))
    expect(rendered).toContain('#12 ladder since')
  })
})

describe('pnpm state:* writes', () => {
  it('appends the next numbered decision, writes the file whole and journals its sha256', () => {
    const places = world()
    const seen = { out: [], err: [] }
    expect(runState(['decision', 'cards', 'go', 'through', 'state', '--cards', '#738', '750'], deps(places, seen))).toBe(0)
    expect(readFileSync(places.decisions, 'utf8')).toBe(`${DECISIONS}- D-3 · 2026-10-10 — cards go through state · card #738 #750\n`)
    expect(stateEvents(places)).toEqual([expect.objectContaining({ write: 'decision', file: places.decisions, decision: 3 })])
    expect(stateFindings(places)).toEqual([])
  })

  it('refuses a decision the record would refuse and writes nothing', () => {
    const places = world()
    const seen: Seen = { out: [], err: [] }
    expect(runState(['decision', 'a decision still in force'], deps(places, seen))).toBe(1)
    expect(seen.err.join('\n')).toContain('repeats D-2')
    expect(readFileSync(places.decisions, 'utf8')).toBe(DECISIONS)
    expect(stateEvents(places)).toEqual([])
  })

  it('writes a parked card only when it parses, and journals it', () => {
    const places = world()
    writeFileSync(path.join(places.home, 'draft.md'), card(15))
    writeFileSync(path.join(places.home, 'bad.md'), 'card: nothing\n')
    expect(runState(['card', 'lane-1/15.md', 'bad.md'], deps(places))).toBe(1)
    expect(existsSync(path.join(places.parking, 'lane-1', '15.md'))).toBe(false)
    expect(runState(['card', 'lane-1/15.md', 'draft.md'], deps(places))).toBe(0)
    expect(readView('queue', places).lines.at(-1)).toContain('#15 task-15')
    expect(stateEvents(places)).toEqual([expect.objectContaining({ write: 'card', card: 15 })])
  })

  it('journals a note as an event:note line', () => {
    const places = world()
    expect(runState(['note', '738', 'window', 'took', 'body', '#738'], deps(places))).toBe(0)
    expect(readFileSync(places.journal, 'utf8').trim().split('\n').at(-1)).toContain('"event":"note","task":"738","note":"window took body #738","by":"state:note"')
  })

  it('writes the handoff through handoff:write and journals the file it wrote', () => {
    const places = world()
    const draft = path.join(places.home, 'draft.md')
    writeFileSync(draft, `## STOP — window 1\nin-flight: none\n${HANDOFF_FIELDS.map(field => `${field.label}: ${field.label === 'queue' ? 'none' : field.id === 'decisions' ? places.decisions : 'x'}`).join('\n')}\nSTATUS: CONTINUE\n`)
    expect(runState(['handoff', 'operator.md', draft], deps(places))).toBe(0)
    const handoff = path.join(path.dirname(places.journal), 'operator.md')
    expect(readFileSync(handoff, 'utf8')).toContain('prev: none')
    expect(stateEvents(places)).toEqual([expect.objectContaining({ write: 'handoff', file: handoff })])
  })

  it('refuses an unknown verb', () => {
    expect(runState(['erase'], deps(world()))).toBe(2)
  })
})

describe('the write lock', () => {
  it('concurrent writes: two state:decision runs at once both land in the file and in the journal', async () => {
    const places = world()
    const results = await Promise.all([writer(places, ['decision', 'one from the first writer']), writer(places, ['decision', 'one from the second writer'])])
    expect(results).toEqual([{ code: 0, stderr: '' }, { code: 0, stderr: '' }])
    const text = readFileSync(places.decisions, 'utf8')
    expect(text).toContain('one from the first writer')
    expect(text).toContain('one from the second writer')
    expect(text).toMatch(/- D-3 · .*\n- D-4 · /)
    expect(stateEvents(places).map(event => event.decision).sort()).toEqual([3, 4])
    expect(stateFindings(places)).toEqual([])
  })

  it('concurrent writes: a writer waits while a live process holds the lock, then lands', async () => {
    const places = world()
    mkdirSync(path.dirname(places.lock), { recursive: true })
    writeFileSync(places.lock, `${process.pid}\n`)
    const pending = writer(places, ['decision', 'written after the lock is released'])
    await new Promise(resolve => setTimeout(resolve, 1500))
    expect(readFileSync(places.decisions, 'utf8')).toBe(DECISIONS)
    rmSync(places.lock)
    expect(await pending).toEqual({ code: 0, stderr: '' })
    expect(readFileSync(places.decisions, 'utf8')).toContain('- D-3 · ')
  })

  it('takes over a lock whose holder is dead', () => {
    const places = world()
    mkdirSync(path.dirname(places.lock), { recursive: true })
    writeFileSync(places.lock, '999999\n')
    expect(runState(['note', '738', 'after', 'a', 'dead', 'holder'], deps(places))).toBe(0)
    expect(existsSync(places.lock)).toBe(false)
  })
})
