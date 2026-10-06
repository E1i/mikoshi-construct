import type { TaskStartDeps } from '../scripts/ghosts/task-start.js'
import type { AdmitOptions, AdmitResult } from '../src/commands/intake/admit.js'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readJournalFile, runTaskStart } from '../scripts/ghosts/task-start.js'
import { printAdmit, runAdmit } from '../src/commands/intake/admit.js'
import { bodySha } from '../src/commands/intake/confirm.js'
import { INTAKE_EXIT, runIntake } from '../src/commands/intake/index.js'
import { createUi } from '../src/ui/console.js'
import { resolveTheme } from '../src/ui/theme.js'

const NOW = new Date('2026-10-05T09:00:00.000Z')
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

function admit(w: World, file: string, options: Partial<AdmitOptions> = {}): AdmitResult {
  return runAdmit({ file, dir: w.repo, journal: w.journal, dryRun: false, autoConfirm: false, ...options }, () => NOW)
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
    append: () => undefined,
    now: () => NOW,
    session: 's1',
    handoffDir: path.dirname(w.journal),
    readJournal: readJournalFile,
  }
  return runTaskStart(['feat/admitted', '--card', card], deps).exitCode
}

const CLEAN = '#80 clean-card [implement/runner/S/cheap/owner] · depends — · blocks —'
const STALE = '#81 stale-card [implement/runner/S/cheap/owner] · depends #70 #80 · blocks #90 the board card'
const STALE_ADMITTED = '#81 stale-card [implement/runner/S/cheap/owner] · depends #80 · blocks #90 the board card'

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

  it('holds a card with a correction behind the confirmation token, and admits it once a person confirms', () => {
    const w = world()
    park(w, 80, CLEAN)
    park(w, 90, CLEAN.replace('#80 clean-card', '#90 board-card'))
    const file = park(w, 81, STALE)
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
    expect(after).toBe(before.replace(STALE, STALE_ADMITTED).replace('Do the thing.\n', 'Do the thing.\n\ncorrected: depends — #70 → (removed) — already merged\n'))
    expect(journalLines(w).at(-1)).toMatchObject({ event: 'intake', task: '81', card: STALE_ADMITTED, confirmation: 'person', source: 'admit' })
    appendFileSync(w.journal, `${JSON.stringify({ event: 'merge', task: '80', by: 'E1i', commit: 'c0ffee', ts: '2026-10-05T00:00:00.000Z' })}\n`)
    expect(taskStart(w, STALE_ADMITTED)).toBe(0)
    expect(taskStart(w, STALE)).toBe(1)
  })

  it('a stale --confirm admits nothing', () => {
    const w = world()
    const file = park(w, 81, STALE)
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

  it('an unchanged admitted card writes nothing', () => {
    const w = world()
    const file = park(w, 80, CLEAN, 'src/board/**', 'Do the thing.\n\nWitnesses:\n- `pnpm vitest run` exit 0')
    expect(admit(w, file).status).toBe('admitted')
    const before = readFileSync(file, 'utf8')
    const again = admit(w, file)
    expect(again).toMatchObject({ status: 'alreadyAdmitted', source: 'amend' })
    expect(printed(again).lines.join('\n')).toContain('nothing was written')
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
