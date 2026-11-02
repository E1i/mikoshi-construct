import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { runCommand } from 'citty'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BUS_DB_VARIABLE } from '../scripts/core/bus-path.js'
import { openBus } from '../scripts/core/db.js'
import { INTAKE_EXIT } from '../src/commands/intake/index.js'
import { createMain } from '../src/program.js'
import { PLAIN_LORE } from '../src/ui/lore.js'

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

async function throughEntry(w: World, flags: string[]): Promise<{ exit: typeof process.exitCode, output: string }> {
  const written: string[] = []
  const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    written.push(String(chunk))
    return true
  })
  const previousExit = process.exitCode
  try {
    await runCommand(createMain(), { rawArgs: ['intake', '--plain', '--dir', w.repo, '--parking', w.parking, '--dry-run', ...flags] })
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
})
