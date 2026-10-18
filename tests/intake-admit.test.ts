import type { TaskStartDeps } from '../scripts/ghosts/task-start.js'
import type { AdmitOptions, AdmitResult } from '../src/commands/intake/admit.js'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { runCommand } from 'citty'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BUS_DB_VARIABLE, openBus } from '../scripts/bus/db.js'
import { busCardEvents } from '../scripts/bus/intake.js'
import { readJournalFile, runTaskStart } from '../scripts/ghosts/task-start.js'
import { printAdmit, runAdmit } from '../src/commands/intake/admit.js'
import { bodySha, bodyShaWithoutTouches } from '../src/commands/intake/confirm.js'
import { INTAKE_EXIT, runIntake } from '../src/commands/intake/index.js'
import { isWithin, parkingTree } from '../src/commands/intake/parking-tree.js'
import { createMain } from '../src/program.js'
import { createUi } from '../src/ui/console.js'
import { resolveTheme } from '../src/ui/theme.js'

const NOW = new Date('2026-10-05T09:00:00.000Z')
const A_MINUTE_LATER = new Date(NOW.getTime() + 60_000)
const AN_HOUR_LATER = new Date(NOW.getTime() + 3_600_000)
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

interface World { root: string, parking: string, journal: string, repo: string }

function world(): World {
  const root = mkdtempSync(path.join(tmpdir(), 'intake-admit-'))
  roots.push(root)
  const repo = path.join(root, 'repo')
  mkdirSync(path.join(repo, 'src', 'board'), { recursive: true })
  writeFileSync(path.join(repo, 'src', 'board', 'run.ts'), '')
  return { root, parking: path.join(root, 'parking'), journal: path.join(root, 'handoff', 'ghosts.jsonl'), repo }
}

function park(w: World, id: number, card: string, touches = 'src/board/**', body = 'Do the thing.'): string {
  mkdirSync(w.parking, { recursive: true })
  const file = path.join(w.parking, `${id}.md`)
  writeFileSync(file, `card: ${card}\nbranch: feat/card-${id}\ntouches: ${touches}\ncontinue: stop\nwho: shift\n\n${body}\n`)
  return file
}

function journal(w: World, lines: Record<string, unknown>[]): void {
  mkdirSync(path.dirname(w.journal), { recursive: true })
  writeFileSync(w.journal, lines.map(line => `${JSON.stringify(line)}\n`).join(''))
}

function journalLines(w: World): Record<string, unknown>[] {
  return existsSync(w.journal) ? readFileSync(w.journal, 'utf8').trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>) : []
}

function busOf(w: World): string {
  return path.join(path.dirname(w.journal), 'bus.db')
}

function admit(w: World, file: string, options: Partial<AdmitOptions> = {}, at: Date = NOW): AdmitResult {
  const db = openBus(busOf(w))
  try {
    return runAdmit({ file, dir: w.repo, journal: w.journal, dryRun: false, autoConfirm: false, parkingRoot: w.parking, events: busCardEvents(db), ...options }, () => at)
  }
  finally {
    db.close()
  }
}

function admittedRows(w: World): { ts: string, payload: string }[] {
  const db = openBus(busOf(w))
  try {
    return db.prepare(`SELECT ts, payload FROM events WHERE type = 'card.admitted' ORDER BY id`).all() as unknown as { ts: string, payload: string }[]
  }
  finally {
    db.close()
  }
}

function admittedPayloads(w: World): Record<string, unknown>[] {
  return admittedRows(w).map(row => JSON.parse(row.payload) as Record<string, unknown>)
}

function payloadsOf(w: World, type: string): Record<string, unknown>[] {
  const db = openBus(busOf(w))
  try {
    return (db.prepare('SELECT payload FROM events WHERE type = ? ORDER BY id').all(type) as unknown as { payload: string }[]).map(row => JSON.parse(row.payload) as Record<string, unknown>)
  }
  finally {
    db.close()
  }
}

function admittedTimes(w: World): string[] {
  return admittedRows(w).map(row => row.ts)
}

function admittedEvents(w: World): number {
  const db = openBus(busOf(w))
  try {
    return Number((db.prepare(`SELECT count(*) AS n FROM events WHERE type = 'card.admitted'`).get() as { n: number }).n)
  }
  finally {
    db.close()
  }
}

function printed(result: AdmitResult): { lines: string[], exit: number } {
  const lines: string[] = []
  const exit = printAdmit(createUi(resolveTheme({ plain: true }), line => lines.push(line)), result)
  return { lines, exit }
}

function taskStart(w: World, card: string): number {
  const deps: TaskStartDeps = {
    cwd: '/repo',
    git: (_cwd, args) => {
      if (args[0] === 'show-ref')
        throw new Error('no such branch')
      return args[0] === 'rev-parse' ? '/work/repo\n' : ''
    },
    install: () => undefined,
    exists: () => false,
    bus: busOf(w),
    now: () => NOW,
    session: 's1',
    handoffDir: path.dirname(w.journal),
    readJournal: readJournalFile,
  }
  return runTaskStart(['feat/admitted', '--card', card], deps).exitCode
}

const CLEAN = '#80 clean-card [implement/runner/S/cheap/owner] · depends — · blocks —'
const STALE = '#81 stale-card [implement/runner/S/cheap/owner] · depends #70 · blocks #90 the board card'
const STALE_ADMITTED = '#81 stale-card [implement/runner/S/cheap/owner] · depends — · blocks #90 the board card'
const WAITING = '#82 waiting-card [implement/runner/S/cheap/owner] · depends #80 · blocks —'
const STALE_WAITING = '#83 stale-waiting-card [implement/runner/S/cheap/owner] · depends #70 #80 · blocks #90 the board card'
const STALE_WAITING_ADMITTED = '#83 stale-waiting-card [implement/runner/S/cheap/owner] · depends — · blocks #90 the board card'

describe('construct intake --admit takes a card parked before the intake door', () => {
  it('writes an intake line for a card with nothing to correct, leaves the file as it was, and task:start takes the card', () => {
    const w = world()
    const file = park(w, 80, CLEAN)
    const before = readFileSync(file, 'utf8')
    expect(taskStart(w, CLEAN)).toBe(1)
    const result = admit(w, file)
    expect(result.status).toBe('admitted')
    expect(printed(result).exit).toBe(INTAKE_EXIT.admitted)
    expect(readFileSync(file, 'utf8')).toBe(before)
    expect(journalLines(w)).toEqual([{ event: 'intake', task: '80', card: CLEAN, confirmation: 'none', corrections: [], bodySha: bodySha(before), source: 'admit', ts: NOW.toISOString() }])
    expect(taskStart(w, CLEAN)).toBe(0)
  })

  it('an amend that only drops merged depends needs no person', () => {
    const w = world()
    park(w, 80, CLEAN)
    park(w, 90, CLEAN.replace('#80 clean-card', '#90 board-card'))
    const file = park(w, 81, STALE)
    journal(w, [{ event: 'path', task: '70', path: 'cheap', pr: 1, verification: 'run' }, { event: 'merge', task: '70', by: 'E1i', commit: 'c0ffee', ts: '2026-10-05T00:00:00.000Z' }])
    expect(admit(w, file).status).toBe('admitted')
    expect(journalLines(w).at(-1)).toMatchObject({ event: 'intake', task: '81', card: STALE_ADMITTED, confirmation: 'none' })
  })

  it('any other correction still needs a person', () => {
    const w = world()
    park(w, 80, CLEAN)
    park(w, 90, CLEAN.replace('#80 clean-card', '#90 board-card'))
    const file = park(w, 81, STALE, 'scripts/board/run.ts')
    journal(w, [{ event: 'path', task: '70', path: 'cheap', pr: 1, verification: 'run' }, { event: 'merge', task: '70', by: 'E1i', commit: 'c0ffee', ts: '2026-10-05T00:00:00.000Z' }])
    expect(admit(w, file).status).toBe('awaiting')
  })

  it('holds a card with a correction behind the confirmation token, and admits it once a person confirms', () => {
    const w = world()
    park(w, 80, CLEAN)
    park(w, 90, CLEAN.replace('#80 clean-card', '#90 board-card'))
    const file = park(w, 81, STALE, 'scripts/board/run.ts')
    const before = readFileSync(file, 'utf8')
    journal(w, [{ event: 'path', task: '70', path: 'cheap', pr: 1, verification: 'run' }, { event: 'merge', task: '70', by: 'E1i', commit: 'c0ffee', ts: '2026-10-05T00:00:00.000Z' }])

    const held = admit(w, file)
    expect(held.status).toBe('awaiting')
    const { lines, exit } = printed(held)
    expect(exit).toBe(INTAKE_EXIT.awaiting)
    expect(lines.join('\n')).toContain('corrected: depends — #70 → (removed) — already merged')
    expect(readFileSync(file, 'utf8')).toBe(before)
    expect(journalLines(w)).toHaveLength(2)

    const token = held.status === 'awaiting' ? held.token : ''
    expect(admit(w, file, { confirm: token }).status).toBe('admitted')
    const after = readFileSync(file, 'utf8')
    expect(after).toBe(before.replace(STALE, STALE_ADMITTED).replace('touches: scripts/', 'touches: src/').replace('Do the thing.\n', `Do the thing.\n\ncorrected: touches — scripts/board/run.ts → src/board/run.ts — 'scripts/board/run.ts' does not exist; 'src/board/run.ts' is the only path named 'run.ts'\ncorrected: depends — #70 → (removed) — already merged\n`))
    expect(journalLines(w).at(-1)).toMatchObject({ event: 'intake', task: '81', card: STALE_ADMITTED, confirmation: 'person', source: 'admit' })
    expect(taskStart(w, STALE_ADMITTED)).toBe(0)
    expect(taskStart(w, STALE)).toBe(1)
  })

  it('a card whose depends are not merged is not admitted and stays in the queue as blocked with a waiting on #N event', () => {
    const w = world()
    park(w, 80, CLEAN)
    const file = park(w, 82, WAITING)
    const before = readFileSync(file, 'utf8')

    const waiting = admit(w, file)
    expect(waiting).toMatchObject({ status: 'waiting', waitingOn: [80], inBus: true })
    const { lines, exit } = printed(waiting)
    expect(exit).toBe(INTAKE_EXIT.waiting)
    expect(lines.join('')).toContain(`Not admitted yet ${file}: ${WAITING}. It depends on #80, not merged yet`)
    expect(readFileSync(file, 'utf8')).toBe(before)
    expect(journalLines(w)).toEqual([])
    expect(admittedEvents(w)).toBe(0)
    expect(payloadsOf(w, 'card.waiting')).toEqual([{ depends: [80] }])
    expect(taskStart(w, WAITING)).toBe(1)

    journal(w, [{ event: 'merge', task: '80', by: 'E1i', commit: 'c0ffee', ts: '2026-10-05T00:00:00.000Z' }])
    expect(admit(w, file).status).toBe('admitted')
    expect(admittedEvents(w)).toBe(1)
  })

  it('a card waiting on an unmerged depends writes no card.waiting when no bus is wired, and an amend of an admitted card does not wait', () => {
    const w = world()
    park(w, 80, CLEAN)
    const file = park(w, 82, WAITING)
    const waiting = admit(w, file, { events: undefined })
    expect(waiting).toMatchObject({ status: 'waiting', inBus: false })
    expect(printed(waiting).lines.join('')).toContain('no bus is wired to this run, so nothing was written')
    expect(payloadsOf(w, 'card.waiting')).toEqual([])

    journal(w, [{ event: 'intake', task: '82', card: WAITING, bodySha: 'an earlier body', source: 'admit', ts: NOW.toISOString() }])
    expect(admit(w, file, { events: undefined }).status).toBe('admitted')
  })

  it('a corrected card that keeps an unmerged depends waits before it asks for a confirmation, and is held behind the token once the depends merges', () => {
    const w = world()
    park(w, 80, CLEAN)
    park(w, 90, CLEAN.replace('#80 clean-card', '#90 board-card'))
    const file = park(w, 83, STALE_WAITING, 'scripts/board/run.ts')
    const before = readFileSync(file, 'utf8')
    const merge70 = { event: 'merge', task: '70', by: 'E1i', commit: 'c0ffee', ts: '2026-10-05T00:00:00.000Z' }
    journal(w, [merge70])

    expect(admit(w, file)).toMatchObject({ status: 'waiting', waitingOn: [80] })
    expect(readFileSync(file, 'utf8')).toBe(before)
    expect(journalLines(w)).toHaveLength(1)

    journal(w, [merge70, { event: 'merge', task: '80', by: 'E1i', commit: 'c0ffee', ts: '2026-10-05T00:00:00.000Z' }])
    const held = admit(w, file)
    expect(held.status).toBe('awaiting')
    const token = held.status === 'awaiting' ? held.token : ''
    expect(admit(w, file, { confirm: token })).toMatchObject({ status: 'admitted', card: { line: STALE_WAITING_ADMITTED } })
  })

  it('a depends on a card that is neither parked, done nor merged is admitted with an unclear mark, not left waiting', () => {
    const w = world()
    const file = park(w, 82, WAITING.replace('depends #80', 'depends #79'))
    expect(admit(w, file)).toMatchObject({ status: 'admitted', card: { unclear: [{ field: 'depends' }] } })
    expect(readFileSync(file, 'utf8')).toContain('unclear: depends')
    expect(payloadsOf(w, 'card.waiting')).toEqual([])
  })

  it('a dry run of a first admission with an unmerged depends reports the wait and writes nothing', () => {
    const w = world()
    park(w, 80, CLEAN)
    const file = park(w, 82, WAITING)
    const before = readFileSync(file, 'utf8')
    const dry = admit(w, file, { dryRun: true })
    expect(dry).toMatchObject({ status: 'waiting', waitingOn: [80], dryRun: true })
    const { lines, exit } = printed(dry)
    expect(exit).toBe(INTAKE_EXIT.waiting)
    expect(lines.join('')).toContain('so --admit would leave it parked and write a card.waiting. Nothing was written.')
    expect(readFileSync(file, 'utf8')).toBe(before)
    expect(payloadsOf(w, 'card.waiting')).toEqual([])
  })

  it('a stale --confirm admits nothing', () => {
    const w = world()
    const file = park(w, 81, STALE, 'scripts/board/run.ts')
    journal(w, [{ event: 'path', task: '70', path: 'cheap', pr: 1, verification: 'run' }, { event: 'merge', task: '70', by: 'E1i', commit: 'c0ffee', ts: '2026-10-05T00:00:00.000Z' }])
    const held = admit(w, file, { confirm: 'not-the-token' })
    expect(held).toMatchObject({ status: 'awaiting', stale: true })
    expect(journalLines(w)).toHaveLength(2)
  })

  it('a second --admit of an admitted card writes no second intake line', () => {
    const w = world()
    const file = park(w, 80, CLEAN)
    admit(w, file)
    const again = admit(w, file)
    expect(again.status).toBe('alreadyAdmitted')
    expect(printed(again).exit).toBe(INTAKE_EXIT.alreadyAdmitted)
    expect(journalLines(w)).toHaveLength(1)
  })

  it('an unchanged admitted card writes no file and no intake line', () => {
    const w = world()
    const file = park(w, 80, CLEAN, 'src/board/**', 'Do the thing.\n\nWitnesses:\n- `pnpm vitest run` exit 0')
    expect(admit(w, file).status).toBe('admitted')
    const before = readFileSync(file, 'utf8')
    const again = admit(w, file)
    expect(again).toMatchObject({ status: 'alreadyAdmitted', source: 'amend' })
    expect(printed(again).lines.join('\n')).toContain('Its card.admitted is in the bus')
    expect(readFileSync(file, 'utf8')).toBe(before)
    expect(journalLines(w)).toHaveLength(1)
  })

  it('amends an admitted card whose task text or witnesses changed, and the unchanged amendment is then already admitted', () => {
    const w = world()
    const file = park(w, 80, CLEAN, 'src/board/**', 'Do the thing.\n\nWitnesses:\n- `pnpm vitest run` exit 0')
    admit(w, file)
    park(w, 80, CLEAN, 'src/board/**', 'Do the corrected thing.\n\nWitnesses:\n- `pnpm vitest run` exit 0')
    const amended = admit(w, file)
    expect(amended).toMatchObject({ status: 'admitted', source: 'amend' })
    const { lines, exit } = printed(amended)
    expect(exit).toBe(INTAKE_EXIT.admitted)
    expect(lines.join('\n')).toContain('80.md: #80 clean-card')
    expect(lines.join('\n')).toContain('source amend')
    expect(journalLines(w).at(-1)).toMatchObject({ event: 'intake', task: '80', card: CLEAN, source: 'amend', bodySha: bodySha(readFileSync(file, 'utf8')) })

    park(w, 80, CLEAN, 'src/board/**', 'Do the corrected thing.\n\nWitnesses:\n- `pnpm vitest run` exit 1')
    expect(admit(w, file)).toMatchObject({ status: 'admitted', source: 'amend' })
    expect(journalLines(w)).toHaveLength(3)
    expect(admit(w, file).status).toBe('alreadyAdmitted')
    expect(journalLines(w)).toHaveLength(3)
    expect(taskStart(w, CLEAN)).toBe(0)
  })

  it('amends an admitted card whose only change is its touches line, and the unchanged amendment is then already admitted', () => {
    const w = world()
    mkdirSync(path.join(w.repo, 'src', 'card'), { recursive: true })
    writeFileSync(path.join(w.repo, 'src', 'card', 'grammar.ts'), '')
    const file = park(w, 80, CLEAN)
    expect(admit(w, file).status).toBe('admitted')
    park(w, 80, CLEAN, 'src/board/**, src/card/grammar.ts')
    const amended = admit(w, file)
    expect(amended).toMatchObject({ status: 'admitted', source: 'amend' })
    expect(printed(amended).lines.join('\n')).toContain('source amend')
    const after = readFileSync(file, 'utf8')
    expect(after).toContain('touches: src/board/**, src/card/grammar.ts\n')
    expect(journalLines(w)).toHaveLength(2)
    expect(journalLines(w).at(-1)).toMatchObject({ event: 'intake', task: '80', card: CLEAN, source: 'amend', bodySha: bodySha(after) })
    expect(bodySha(after)).not.toBe(journalLines(w)[0]!.bodySha)
    expect(admit(w, file).status).toBe('alreadyAdmitted')
    expect(journalLines(w)).toHaveLength(2)
  })

  it('a card admitted when the digest left out its touches line, and unchanged since, writes no intake line', () => {
    const w = world()
    const file = park(w, 80, CLEAN)
    const text = readFileSync(file, 'utf8')
    expect(bodyShaWithoutTouches(text)).not.toBe(bodySha(text))
    journal(w, [{ event: 'intake', task: '80', card: CLEAN, confirmation: 'none', corrections: [], bodySha: bodyShaWithoutTouches(text), source: 'admit', ts: NOW.toISOString() }])
    const again = admit(w, file)
    expect(again).toMatchObject({ status: 'alreadyAdmitted', source: 'amend' })
    expect(printed(again).lines.join('\n')).toContain('Its card.admitted is in the bus')
    expect(journalLines(w)).toHaveLength(1)
  })

  it('amends an admitted card through the parking grammar: a refused file writes nothing, and a correction waits for its token', () => {
    const w = world()
    const file = park(w, 80, CLEAN)
    admit(w, file)
    writeFileSync(file, `card: ${CLEAN}\nbranch: feat/card-80\ntouches: src/board/**\ncontinue: stop\n\nDo the thing.\n`)
    expect(admit(w, file).status).toBe('refused')
    park(w, 80, CLEAN, 'scripts/board/run.ts', 'Do the other thing.')
    expect(admit(w, file).status).toBe('awaiting')
    expect(journalLines(w)).toHaveLength(1)
  })

  it('amends a card whose intake line recorded no body digest, since the text it admitted is unknown', () => {
    const w = world()
    const file = park(w, 80, CLEAN)
    journal(w, [{ event: 'intake', task: '80', card: CLEAN, confirmation: 'none', corrections: [], source: 'admit', ts: NOW.toISOString() }])
    expect(admit(w, file)).toMatchObject({ status: 'admitted', source: 'amend' })
    expect(journalLines(w).at(-1)).toMatchObject({ source: 'amend', bodySha: bodySha(readFileSync(file, 'utf8')) })
  })

  it('corrects a touches entry to the only path of that name, and marks one that names no path unclear without changing who', () => {
    const w = world()
    const file = park(w, 80, CLEAN, 'scripts/board/run.ts, src/nowhere.ts')
    const result = admit(w, file, { autoConfirm: true })
    expect(result.status).toBe('admitted')
    const text = readFileSync(file, 'utf8')
    expect(text).toContain('touches: src/board/run.ts, src/nowhere.ts\n')
    expect(text).toContain('who: shift\n')
    expect(text).toContain('corrected: touches — scripts/board/run.ts → src/board/run.ts')
    expect(text).toContain(`unclear: touches — 'src/nowhere.ts' does not exist`)
    expect(journalLines(w)[0]).toMatchObject({ confirmation: 'auto', source: 'admit' })
  })

  it('--dry-run prints the card it would admit and writes nothing', () => {
    const w = world()
    const file = park(w, 80, CLEAN)
    const result = admit(w, file, { dryRun: true })
    expect(result.status).toBe('dryRun')
    expect(printed(result).exit).toBe(INTAKE_EXIT.dryRun)
    expect(existsSync(w.journal)).toBe(false)
  })

  it('admit refuses a witness whose -t is not a regex', () => {
    const w = world()
    const witness = '`pnpm exec vitest run tests/a.test.ts -t \'a named file against tests/** is no conflict\'` exit 0'
    const file = park(w, 80, CLEAN, 'src/board/**', `Do the thing.\n\nWitnesses:\n- ${witness}`)
    const before = readFileSync(file, 'utf8')
    const result = admit(w, file)
    expect(result.status).toBe('invalidTestPattern')
    const { lines, exit } = printed(result)
    expect(exit).toBe(INTAKE_EXIT.refused)
    expect(lines.join('\n')).toContain(witness)
    expect(lines.join('\n')).toContain('Nothing to repeat')
    expect(readFileSync(file, 'utf8')).toBe(before)
    expect(existsSync(w.journal)).toBe(false)
  })

  it('admit takes a witness whose -t compiles', () => {
    const w = world()
    const file = park(w, 80, CLEAN, 'src/board/**', 'Do the thing.\n\nWitnesses:\n- `pnpm exec vitest run tests/a.test.ts -t \'tests/\\*\\*\'` exit 0')
    expect(admit(w, file).status).toBe('admitted')
  })

  it('refuses a file that is not a parked card, and --admit beside --draft', () => {
    const w = world()
    mkdirSync(w.parking, { recursive: true })
    const file = path.join(w.parking, '80.md')
    writeFileSync(file, 'not a card\n')
    expect(printed(admit(w, file)).exit).toBe(INTAKE_EXIT.refused)
    expect(runIntake({ admit: file, draft: 'd.json', taken: '-', parking: w.parking, dir: w.repo, journal: w.journal, dryRun: false, autoConfirm: false, readStdin: () => '' })).toMatchObject({ status: 'refused', refusal: 'admitWithDraft' })
    expect(existsSync(w.journal)).toBe(false)
  })
})

describe('construct intake --admit with the bus counts a journal line only before the cutoff', () => {
  it('a journal intake line after the cutoff with no card.admitted in the bus does not make the card admitted', () => {
    const w = world()
    const file = park(w, 80, CLEAN)
    journal(w, [{ event: 'intake', task: '80', card: CLEAN, bodySha: bodySha(readFileSync(file, 'utf8')), confirmation: 'none', source: 'admit', ts: '2026-10-13T00:00:00.000Z' }])
    expect(admit(w, file, { admissions: () => null }, new Date('2026-10-13T09:00:00.000Z'))).toMatchObject({ status: 'admitted', source: 'admit' })
  })
})

describe('construct intake --admit says whether task:start will take the card', () => {
  it('names the bus when the port wrote card.admitted, and task:start takes the card', () => {
    const w = world()
    const file = park(w, 80, CLEAN)
    expect(printed(admit(w, file)).lines[0]).toBe(`[ok] Admitted ${file}: ${CLEAN}. Its card.admitted is in the bus, so task:start and the shift take it.\n`)
    expect(taskStart(w, CLEAN)).toBe(0)
  })

  it('says only what it wrote when no bus is wired: the journal line and no card.admitted, which this repository\'s task:start then refuses', () => {
    const w = world()
    const file = park(w, 80, CLEAN)
    expect(printed(admit(w, file, { events: undefined })).lines[0]).toBe(`[ok] Admitted ${file}: ${CLEAN}. Its intake line is in the journal; no bus is wired to this run, so no card.admitted was written.\n`)
    expect(taskStart(w, CLEAN)).toBe(1)
  })

  it('a bus-wired --admit of a card an unwired run admitted writes its card.admitted and no second intake line, and task:start takes the card', () => {
    const w = world()
    const file = park(w, 80, CLEAN)
    admit(w, file, { events: undefined })
    const again = admit(w, file)
    expect(again.status).toBe('alreadyAdmitted')
    expect(printed(again).lines[0]).toBe(`[ok] Already admitted ${file}: ${CLEAN}. Its card.admitted is in the bus, so task:start and the shift take it.\n`)
    expect(journalLines(w)).toHaveLength(1)
    expect(admittedEvents(w)).toBe(1)
    expect(taskStart(w, CLEAN)).toBe(0)
  })

  it('a repeated bus-wired --admit of an admitted card leaves one card.admitted in the bus', () => {
    const w = world()
    const file = park(w, 80, CLEAN)
    admit(w, file)
    admit(w, file, {}, A_MINUTE_LATER)
    admit(w, file, {}, AN_HOUR_LATER)
    expect(admittedEvents(w)).toBe(1)
  })

  it('the card.admitted a bus-wired --admit writes for a journal-admitted card carries the journal line\'s ts, source and confirmation', () => {
    const w = world()
    const file = park(w, 80, CLEAN)
    admit(w, file, { events: undefined, autoConfirm: true })
    admit(w, file, {}, AN_HOUR_LATER)
    expect(admittedPayloads(w)).toEqual([expect.objectContaining({ source: 'admit', confirmation: 'auto' })])
    expect(admittedTimes(w)).toEqual([NOW.toISOString()])
  })

  it('an unwired --admit of an admitted card says nothing was written', () => {
    const w = world()
    const file = park(w, 80, CLEAN)
    admit(w, file, { events: undefined })
    expect(printed(admit(w, file, { events: undefined })).lines[0]).toBe(`[ok] Already admitted ${file}: ${CLEAN}. The journal holds its intake line; no bus is wired to this run, so nothing was written.\n`)
  })

  it('a dry run of an admitted card writes no card.admitted', () => {
    const w = world()
    const file = park(w, 80, CLEAN)
    admit(w, file, { events: undefined })
    admit(w, file, { dryRun: true })
    expect(admittedEvents(w)).toBe(0)
  })
})

describe('construct intake --admit and package.json', () => {
  it('adds the script companions to a card that touches package.json, with no person to confirm', () => {
    const w = world()
    mkdirSync(path.join(w.repo, 'tests'))
    for (const existing of ['package.json', 'CONTRIBUTING.md', 'tests/harness-membership.test.ts'])
      writeFileSync(path.join(w.repo, existing), '')
    const file = park(w, 80, CLEAN, 'package.json, src/board/**')
    expect(admit(w, file).status).toBe('admitted')
    const text = readFileSync(file, 'utf8')
    expect(text).toContain('touches: package.json, src/board/**, CONTRIBUTING.md, tests/harness-membership.test.ts\n')
    expect(text).toContain('corrected: touches — (absent) → CONTRIBUTING.md')
    expect(text).not.toContain('unclear:')
    expect(journalLines(w).at(-1)).toMatchObject({ confirmation: 'none' })
    expect(admit(w, file).status).toBe('alreadyAdmitted')
  })

  it('adds only the companion a card that touches package.json is missing', () => {
    const w = world()
    mkdirSync(path.join(w.repo, 'tests'))
    for (const existing of ['package.json', 'CONTRIBUTING.md', 'tests/harness-membership.test.ts'])
      writeFileSync(path.join(w.repo, existing), '')
    const file = park(w, 80, CLEAN, 'package.json, CONTRIBUTING.md')
    expect(admit(w, file).status).toBe('admitted')
    expect(readFileSync(file, 'utf8')).toContain('touches: package.json, CONTRIBUTING.md, tests/harness-membership.test.ts\n')
  })

  it('adds no companion to a card that does not touch package.json', () => {
    const w = world()
    const file = park(w, 80, CLEAN)
    admit(w, file)
    expect(readFileSync(file, 'utf8')).not.toContain('CONTRIBUTING.md')
  })
})

describe('construct intake --admit and the creates line', () => {
  it('admit keeps the creates line and marks no created path unclear', () => {
    const w = world()
    mkdirSync(w.parking, { recursive: true })
    const file = path.join(w.parking, '80.md')
    writeFileSync(file, `card: ${CLEAN}\nbranch: feat/card-80\ntouches: src/board/fresh.ts\ncreates: src/board/fresh.ts\ncontinue: stop\nwho: shift\n\nDo the thing.\n`)
    const result = admit(w, file)
    expect(result.status).toBe('admitted')
    expect(readFileSync(file, 'utf8')).not.toContain('unclear: touches')
    expect(readFileSync(file, 'utf8')).toContain('creates: src/board/fresh.ts')
  })

  it('admit reads a creates entry with its kind as the path it creates', () => {
    const w = world()
    mkdirSync(w.parking, { recursive: true })
    const file = path.join(w.parking, '80.md')
    writeFileSync(file, `card: ${CLEAN}\nbranch: feat/card-80\ntouches: src/board/fresh.ts\ncreates: src/board/fresh.ts (plain)\ncontinue: stop\nwho: shift\n\nDo the thing.\n`)
    expect(admit(w, file).status).toBe('admitted')
    expect(readFileSync(file, 'utf8')).not.toContain('unclear:')
    expect(readFileSync(file, 'utf8')).toContain('creates: src/board/fresh.ts (plain)')
  })

  it('admit marks a creates entry with a kind outside the list unclear', () => {
    const w = world()
    mkdirSync(w.parking, { recursive: true })
    const file = path.join(w.parking, '80.md')
    writeFileSync(file, `card: ${CLEAN}\nbranch: feat/card-80\ntouches: src/board/fresh.ts\ncreates: src/board/fresh.ts (bogus)\ncontinue: stop\nwho: shift\n\nDo the thing.\n`)
    admit(w, file)
    expect(readFileSync(file, 'utf8')).toContain(`unclear: creates — creates entry 'src/board/fresh.ts (bogus)' names kind 'bogus', not one of ghosts, plain`)
  })

  it('a parked card without a creates line parses as before', () => {
    const w = world()
    const file = park(w, 80, CLEAN, 'src/board/fresh.ts')
    expect(admit(w, file).status).toBe('admitted')
    expect(readFileSync(file, 'utf8')).toContain('unclear: touches')
  })
})

describe('construct intake --admit across the lanes of the parking', () => {
  function parkIn(w: World, lane: string, id: number, card: string): string {
    const dir = path.join(w.parking, lane)
    mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `${id}.md`)
    writeFileSync(file, `card: ${card}\nbranch: feat/card-${id}\ntouches: src/board/**\ncontinue: stop\nwho: shift\n\nDo the thing.\n`)
    return file
  }

  it('a depends on a card parked in another lane is not unclear', () => {
    const w = world()
    parkIn(w, 'lane-1', 53, '#53 first [implement/runner/S/cheap/owner] · depends — · blocks —')
    parkIn(w, 'lane-1', 43, '#43 other [implement/runner/S/cheap/owner] · depends — · blocks —')
    const line = '#58 second [implement/runner/S/cheap/owner] · depends #53 · blocks #43'
    const file = parkIn(w, 'lane-2', 58, line)
    expect(admit(w, file)).toMatchObject({ status: 'waiting', waitingOn: [53], card: { line, unclear: [] } })

    journal(w, [{ event: 'merge', task: '53', by: 'E1i', commit: 'c0ffee', ts: '2026-10-05T00:00:00.000Z' }])
    expect(admit(w, file)).toMatchObject({ status: 'admitted', card: { unclear: [] } })
    expect(readFileSync(file, 'utf8')).not.toContain('unclear:')
  })

  it('a depends on a card parked under another parking root stays unclear', () => {
    const w = world()
    parkIn(w, 'lane-1', 53, '#53 first [implement/runner/S/cheap/owner] · depends — · blocks —')
    const file = parkIn(w, 'lane-2', 58, '#58 second [implement/runner/S/cheap/owner] · depends #53 · blocks —')
    const result = admit(w, file, { parkingRoot: path.join(w.root, 'elsewhere') })
    expect(result).toMatchObject({ status: 'admitted', card: { unclear: [{ field: 'depends' }] } })
    expect(readFileSync(file, 'utf8')).toContain('unclear: depends')
  })
})

describe('the parking tree draft and admit both read', () => {
  it('lists the root and every lane under it, nested lanes included', () => {
    const w = world()
    mkdirSync(path.join(w.parking, 'lane-1', 'nested'), { recursive: true })
    mkdirSync(path.join(w.parking, 'lane-2'), { recursive: true })
    writeFileSync(path.join(w.parking, 'lane-2', '58.md'), '')
    expect(parkingTree(w.parking).sort()).toEqual([
      w.parking,
      path.join(w.parking, 'lane-1'),
      path.join(w.parking, 'lane-1', 'nested'),
      path.join(w.parking, 'lane-2'),
    ])
  })

  it('is empty for a parking root that does not exist', () => {
    expect(parkingTree(path.join(world().root, 'missing'))).toEqual([])
  })

  it('holds the root and its lanes within, and a sibling sharing its prefix outside', () => {
    const w = world()
    expect(isWithin(w.parking, w.parking)).toBe(true)
    expect(isWithin(w.parking, path.join(w.parking, 'lane-1'))).toBe(true)
    expect(isWithin(w.parking, `${w.parking}-other`)).toBe(false)
    expect(isWithin(w.parking, w.root)).toBe(false)
  })
})

describe('construct intake --admit through the CLI entry', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  async function admitThroughEntry(w: World, file: string, extra: string[] = []): Promise<{ exit: typeof process.exitCode, output: string }> {
    const written: string[] = []
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      written.push(String(chunk))
      return true
    })
    const previousExit = process.exitCode
    try {
      await runCommand(createMain(), { rawArgs: ['intake', '--plain', '--admit', file, '--dir', w.repo, '--journal', w.journal, '--parking', w.parking, ...extra] })
      return { exit: process.exitCode, output: written.join('') }
    }
    finally {
      write.mockRestore()
      process.exitCode = previousExit
    }
  }

  it('intake --admit through the CLI entry either writes card.admitted to the bus as pnpm intake does or refuses and names pnpm intake --admit, and never admits silently without the bus event', async () => {
    const w = world()
    const file = park(w, 80, CLEAN)
    openBus(busOf(w)).close()
    vi.stubEnv(BUS_DB_VARIABLE, busOf(w))
    const { exit, output } = await admitThroughEntry(w, file)
    const inBus = admittedEvents(w) > 0
    const refusedAndNamed = exit === INTAKE_EXIT.refused && output.includes('pnpm intake --admit')
    expect(inBus || refusedAndNamed).toBe(true)
    expect(journalLines(w).filter(line => line.event === 'intake')).toHaveLength(inBus ? 1 : 0)
  })

  it('intake --admit --dry-run through the CLI entry beside a bus is never refused and writes nothing', async () => {
    const w = world()
    const file = park(w, 80, CLEAN)
    openBus(busOf(w)).close()
    vi.stubEnv(BUS_DB_VARIABLE, busOf(w))
    const { exit, output } = await admitThroughEntry(w, file, ['--dry-run'])
    expect(exit).not.toBe(INTAKE_EXIT.refused)
    expect(output).not.toContain('pnpm intake --admit instead')
    expect(admittedEvents(w)).toBe(0)
    expect(journalLines(w)).toHaveLength(0)
  })

  it('intake --admit through the CLI entry on a machine with no bus admits into the journal as before', async () => {
    const w = world()
    const file = park(w, 80, CLEAN)
    vi.stubEnv(BUS_DB_VARIABLE, busOf(w))
    const { exit } = await admitThroughEntry(w, file)
    expect(exit).not.toBe(INTAKE_EXIT.refused)
    expect(existsSync(busOf(w))).toBe(false)
    expect(journalLines(w).filter(line => line.event === 'intake')).toHaveLength(1)
  })
})
