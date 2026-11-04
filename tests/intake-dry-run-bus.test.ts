import type { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { runCommand } from 'citty'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BUS_DB_VARIABLE } from '../scripts/core/bus-path.js'
import { openBus } from '../scripts/core/db.js'
import { busIntakePorts } from '../scripts/intake/intake.js'
import { runAdmit } from '../src/commands/intake/admit.js'
import { INTAKE_EXIT } from '../src/commands/intake/index.js'
import { printMove, runMove } from '../src/commands/intake/move.js'
import { createMain } from '../src/program.js'
import { createUi } from '../src/ui/console.js'
import { PLAIN_LORE } from '../src/ui/lore.js'
import { resolveTheme } from '../src/ui/theme.js'

const roots: string[] = []

afterEach(() => {
  vi.unstubAllEnvs()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

interface World { root: string, parking: string, repo: string, bus: string }

function world(): World {
  const root = mkdtempSync(path.join(tmpdir(), 'intake-dry-run-bus-'))
  roots.push(root)
  const repo = path.join(root, 'repo')
  mkdirSync(path.join(repo, 'src', 'board'), { recursive: true })
  writeFileSync(path.join(repo, 'src', 'board', 'run.ts'), '')
  const bus = path.join(root, 'bus.db')
  vi.stubEnv(BUS_DB_VARIABLE, bus)
  return { root, parking: path.join(root, 'parking'), repo, bus }
}

function withBus(w: World): void {
  openBus(w.bus).close()
}

function draftAndTaken(w: World): string[] {
  const draft = path.join(w.root, 'draft.json')
  const card = { name: 'board-run', kind: 'implement', milestone: 'runner', size: 'S', contour: 'cheap', decision: 'auto', who: 'shift', touches: ['src/board/run.ts'], depends: [], task: 'Do the board-run thing.', witnesses: ['`pnpm run quality` is green'] }
  writeFileSync(draft, JSON.stringify({ cards: [card] }))
  const taken = path.join(w.root, 'taken.txt')
  writeFileSync(taken, '1 2 3')
  return ['--draft', draft, '--taken', taken]
}

function parked(w: World): string {
  mkdirSync(w.parking, { recursive: true })
  const file = path.join(w.parking, '80.md')
  writeFileSync(file, 'card: #80 hand-card [implement/runner/S/cheap/owner] · depends — · blocks —\nbranch: feat/card-80\ntouches: src/board/run.ts\ncontinue: stop\nwho: shift\n\nDo the thing.\n')
  return file
}

function admittedInTheBus(w: World, db: DatabaseSync): { file: string, ports: ReturnType<typeof busIntakePorts> } {
  const ports = busIntakePorts(db, 'by-hand', () => 1)
  const file = parked(w)
  expect(runAdmit({ file, dir: w.repo, dryRun: false, autoConfirm: true, parkingRoot: w.parking, events: ports.cardEvents, cardStates: ports.cardStates, admissions: ports.cardAdmissions }).status).toBe('admitted')
  return { file, ports }
}

function allEvents(db: DatabaseSync): unknown {
  return db.prepare('SELECT id, type FROM events ORDER BY id').all()
}

async function throughEntry(w: World, flags: string[], bus?: ReturnType<typeof busIntakePorts>): Promise<{ exit: typeof process.exitCode, output: string }> {
  const written: string[] = []
  const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    written.push(String(chunk))
    return true
  })
  const previousExit = process.exitCode
  try {
    await runCommand(createMain(bus), { rawArgs: ['intake', '--plain', '--dir', w.repo, '--parking', w.parking, '--dry-run', ...flags] })
    return { exit: process.exitCode, output: written.join('') }
  }
  finally {
    write.mockRestore()
    process.exitCode = previousExit
  }
}

describe('construct intake --dry-run sees the cards the write would see', () => {
  it('a draft dry run is refused while a bus is expected and not wired', async () => {
    const w = world()
    withBus(w)
    const { exit, output } = await throughEntry(w, draftAndTaken(w))
    expect(exit).toBe(INTAKE_EXIT.refused)
    expect(output).toContain(PLAIN_LORE.intakeDraftNeedsBus)
    expect(output).not.toContain('card: #')
  })

  it('an admit dry run is refused while a bus is expected and not wired', async () => {
    const w = world()
    withBus(w)
    const { exit, output } = await throughEntry(w, ['--admit', parked(w)])
    expect(exit).toBe(INTAKE_EXIT.refused)
    expect(output).toContain(PLAIN_LORE.intakeAdmitNeedsBus)
  })

  it('a dry run with no bus expected prints the cards', async () => {
    const w = world()
    const { exit, output } = await throughEntry(w, draftAndTaken(w))
    expect(exit).not.toBe(INTAKE_EXIT.refused)
    expect(output).not.toContain(PLAIN_LORE.intakeDraftNeedsBus)
    expect(output).toContain('card: #')
  })

  it('runMove with dryRun: a move --dry-run leaves the journal and the file unchanged and prints the move', () => {
    const w = world()
    const db = openBus(w.bus)
    try {
      const { file, ports } = admittedInTheBus(w, db)
      const before = allEvents(db)
      const result = runMove({ move: '#80', to: 'lane-3', draft: undefined, taken: undefined, admit: undefined, parking: w.parking, dryRun: true, events: ports.cardEvents, admissions: ports.cardAdmissions })
      expect(result).toMatchObject({ status: 'dryRun', from: file })
      const lines: string[] = []
      expect(printMove(createUi(resolveTheme({ plain: true }), line => lines.push(line)), result)).toBe(INTAKE_EXIT.dryRun)
      expect(lines.join('\n')).toContain(path.join(w.parking, 'lane-3', '80.md'))
      expect(lines.join('\n')).toContain(PLAIN_LORE.intakeDryRun(w.parking))
      expect(allEvents(db)).toEqual(before)
      expect(existsSync(file)).toBe(true)
      expect(existsSync(path.join(w.parking, 'lane-3'))).toBe(false)
    }
    finally {
      db.close()
    }
  })

  it('runMove with dryRun: a move --dry-run of a card only the bus holds leaves the journal unchanged and names the card', () => {
    const w = world()
    const db = openBus(w.bus)
    try {
      const { file, ports } = admittedInTheBus(w, db)
      rmSync(file)
      const before = allEvents(db)
      const result = runMove({ move: '#80', to: 'lane-3', draft: undefined, taken: undefined, admit: undefined, parking: w.parking, dryRun: true, events: ports.cardEvents, admissions: ports.cardAdmissions })
      expect(result).toMatchObject({ status: 'dryRun', from: '#80', to: path.join(w.parking, 'lane-3') })
      expect(allEvents(db)).toEqual(before)
      expect(existsSync(path.join(w.parking, 'lane-3'))).toBe(false)
    }
    finally {
      db.close()
    }
  })

  it('through the entry a move --dry-run leaves the journal and the file unchanged and exits as a dry run', async () => {
    const w = world()
    const db = openBus(w.bus)
    try {
      const { file, ports } = admittedInTheBus(w, db)
      const before = allEvents(db)
      const { exit, output } = await throughEntry(w, ['--move', '#80', '--to', 'lane-3'], ports)
      expect(allEvents(db)).toEqual(before)
      expect(existsSync(file)).toBe(true)
      expect(exit).toBe(INTAKE_EXIT.dryRun)
      expect(output).toContain(PLAIN_LORE.intakeDryRun(w.parking))
    }
    finally {
      db.close()
    }
  })
})
