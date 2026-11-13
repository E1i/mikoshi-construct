import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BUS_DB_VARIABLE, openBus } from '../scripts/core/db.js'
import { reduce } from '../scripts/core/reducer.js'
import { busCardAdmissions, busCardEvents, runBusIntake } from '../scripts/intake/intake.js'
import { busProjections } from '../scripts/supervisor/composition.js'
import { runAdmit } from '../src/commands/intake/admit.js'
import { amendedText, listFlagOf } from '../src/commands/intake/amend.js'

const CARD = '#80 touches-forms [implement/runner/S/cheap/owner] · depends — · blocks —'
const TEXT = `card: ${CARD}\nbranch: feat/card-80\ntouches: src/board/run.ts\ncontinue: stop\nwho: shift\n\nDo the thing.\n\nWitnesses:\n- \`pnpm exec vitest run tests/a.test.ts\` exits 0; red on main\n`
const BOTH = 'touches: src/board/run.ts, src/board/a.ts, src/board/b.ts\n'
const roots: string[] = []

afterEach(() => {
  vi.unstubAllEnvs()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

async function dryRun(form: readonly string[]): Promise<string> {
  const root = mkdtempSync(path.join(tmpdir(), 'intake-touches-forms-'))
  roots.push(root)
  const repo = path.join(root, 'repo')
  mkdirSync(path.join(repo, 'src', 'board'), { recursive: true })
  for (const name of ['run', 'a', 'b'])
    writeFileSync(path.join(repo, 'src', 'board', `${name}.ts`), '')
  mkdirSync(path.join(root, '.construct', 'parking'), { recursive: true })
  const bus = path.join(root, 'bus.db')
  vi.stubEnv(BUS_DB_VARIABLE, bus)
  vi.stubEnv('HOME', root)
  const db = openBus(bus)
  const previousExit = process.exitCode
  const printed: string[] = []
  const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    printed.push(String(chunk))
    return true
  })
  try {
    runAdmit({ file: path.join(root, '80.md'), body: TEXT, dir: repo, dryRun: false, autoConfirm: true, events: busCardEvents(db), admissions: busCardAdmissions(db), cardStates: () => new Map() })
    reduce(db, 'pending', busProjections())
    await runBusIntake(db, ['--plain', '--amend', '#80', ...form, '--dry-run', '--dir', repo])
    return printed.join('')
  }
  finally {
    db.close()
    write.mockRestore()
    process.exitCode = previousExit
  }
}

describe('--touches takes a list in every form', () => {
  it('all three forms of --touches give both paths on a dry run', async () => {
    const forms = [
      ['--touches', '+src/board/a.ts,+src/board/b.ts'],
      ['--touches', '+src/board/a.ts', '+src/board/b.ts'],
      ['--touches', '+src/board/a.ts', '--touches', '+src/board/b.ts'],
    ]
    for (const form of forms)
      expect(await dryRun(form)).toContain(BOTH)
  })

  it('one quoted argument with a space between the paths gives both too', async () => {
    expect(await dryRun(['--touches', '+src/board/a.ts +src/board/b.ts'])).toContain(BOTH)
  })

  it('a removal goes inside a list or after the equals sign, and a bare -path is a refused flag, not a silent edit', async () => {
    const amended = 'touches: src/board/a.ts\n'
    expect(await dryRun(['--touches', '+src/board/a.ts,-src/board/run.ts'])).toContain(amended)
    expect(await dryRun(['--touches', '+src/board/a.ts', '--touches=-src/board/run.ts'])).toContain(amended)
    expect(await dryRun(['--touches', '+src/board/a.ts', '-src/board/run.ts'])).not.toContain(amended)
  })

  it('a path with a space stays one entry', () => {
    expect(amendedText(TEXT, { touches: '+src/board/my file.ts' })).toMatchObject({ text: expect.stringContaining('touches: src/board/run.ts, src/board/my file.ts\n') })
    expect(amendedText(TEXT, { touches: '+src/board/my file.ts +src/board/a.ts' })).toMatchObject({ text: expect.stringContaining('touches: src/board/run.ts, src/board/my file.ts, src/board/a.ts\n') })
  })

  it('a flag absent stays absent, and a value stops at the next flag', () => {
    expect(listFlagOf(['--note', 'x'], 'touches')).toBeUndefined()
    expect(listFlagOf(['--touches', '+a', '+b', '--note', 'x', '--touches=-c'], 'touches')).toBe('+a,+b,-c')
  })
})
