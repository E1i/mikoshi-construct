import type { GhRead } from '../../core/gh.js'
import type { OpenIssue, TaskCloseDeps } from '../../ghosts/task-close.js'
import { chmodSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { appendEvent, openBus } from '../../bus/db.js'
import { legacyEventOf } from '../../bus/import.js'
import { CARD_VERIFIED } from '../../core/events.js'
import { VERIFICATION_WORDS } from '../../core/verification.js'
import { cardVerifiedClosings, closingHistoryLines, runTaskClose } from '../../ghosts/task-close.js'
import { prCardOf } from '../../ghosts/tasks.js'
import { failed, ran, read, unread } from '../core/gh-fake.js'
import { busWithCardStarted, journalInBus } from './card-started-bus.js'

const LAUNCH_SESSION = 'ghost-session'

const CONSTRUCT = '/home/.construct'
const REPORTS = path.join(CONSTRUCT, 'reports')
const NOW = new Date('2026-10-03T09:00:00.000Z')
const PROJECTS = '/projects'
const WINDOW_SESSION = 'window-session'

function startLine(id: string, kind: 'implement' | 'probe', session?: string): string {
  const decision = kind === 'probe' ? 'none' : 'owner'
  return JSON.stringify({ event: 'path', task: id, path: 'cheap', started: 'x', ...(session === undefined ? {} : { session }), worktree: `/mc-${id}`, branch: `feat/${id}`, card: { id: Number(id), name: 'n', kind, milestone: 'ghosts', size: 'S', contour: 'cheap', decision, depends: [], blocks: [], line: 'l' }, ts: 'x' })
}

const WORLD_BUSES = mkdtempSync(path.join(tmpdir(), 'task-close-world-'))
let worldBuses = 0

afterAll(() => {
  rmSync(WORLD_BUSES, { recursive: true, force: true })
})

function closingLines(busPath: string): string[] {
  if (!existsSync(busPath))
    return []
  const db = openBus(busPath)
  try {
    const rows = db.prepare(`SELECT ts, card_id, payload FROM events WHERE type = '${CARD_VERIFIED}' ORDER BY id`).all() as { ts: string, card_id: number, payload: string }[]
    return rows.map(row => JSON.stringify({ event: 'path', task: String(row.card_id), ...JSON.parse(row.payload) as object, ts: row.ts }))
  }
  finally {
    db.close()
  }
}

function liveClosings(busPath: string): string[] {
  const shown: string[] = []
  return new Proxy(shown, {
    get(target, property, receiver) {
      target.splice(0, target.length, ...closingLines(busPath))
      return Reflect.get(target, property, receiver)
    },
  })
}

function world(journal: string[], sessionFiles: string[] = [], files: Record<string, string> = {}): { deps: TaskCloseDeps, written: string[] } {
  worldBuses += 1
  const busPath = path.join(WORLD_BUSES, `bus-${worldBuses}.db`)
  journalInBus(busPath, journal)
  return {
    written: liveClosings(busPath),
    deps: {
      cwd: '/work',
      read: file => files[file] ?? null,
      busPath,
      now: () => NOW,
      constructDir: CONSTRUCT,
      realpath: file => file,
      exists: file => sessionFiles.includes(file),
      session: undefined,
      projectsDir: PROJECTS,
      tokens: () => null,
      prBody: () => read(null),
    },
  }
}

function sessionFile(key: string, id: string): string {
  return path.join(PROJECTS, key, `${id}.jsonl`)
}

describe('task:close keeps a report under the construct directory', () => {
  const probes = path.join(CONSTRUCT, 'probes')

  it('refuses a report outside ~/.construct/reports and ~/.construct/probes', () => {
    const { deps, written } = world([startLine('7', 'probe')])
    for (const report of ['/elsewhere/r.md', 'relative.md', `${REPORTS}/../elsewhere/r.md`, `${CONSTRUCT}/reports-other/r.md`, REPORTS]) {
      const result = runTaskClose(['7', '--report', report, '--verification', 'run'], deps)
      expect(result.exitCode).toBe(1)
      expect(result.stderr[0]).toContain(`is outside ${REPORTS} and ${probes}`)
    }
    expect(written).toEqual([])
  })

  it('refuses a report whose symlink leads outside the roots', () => {
    const { deps, written } = world([startLine('7', 'probe')])
    const result = runTaskClose(['7', '--report', `${REPORTS}/link.md`, '--verification', 'run'], { ...deps, realpath: file => file === `${REPORTS}/link.md` ? '/elsewhere/r.md' : file })
    expect(result.exitCode).toBe(1)
    expect(written).toEqual([])
  })

  it('accepts a report under ~/.construct/reports and under ~/.construct/probes', () => {
    for (const report of [`${REPORTS}/r.md`, `${probes}/name/report.md`]) {
      const { deps, written } = world([startLine('7', 'probe')])
      expect(runTaskClose(['7', '--report', report, '--verification', 'run'], deps).exitCode).toBe(0)
      expect(written).toHaveLength(1)
    }
  })
})

describe('w3: task:close writes the closing line the board reads', () => {
  it('w3: an implement task closes with its PR and the verification word', () => {
    const { deps, written } = world([startLine('123', 'implement')])
    const result = runTaskClose(['123', '--pr', '460', '--verification', 'run'], deps)
    expect(result.exitCode).toBe(0)
    expect(written.map(text => JSON.parse(text) as unknown)).toEqual([{ event: 'path', task: '123', path: 'cheap', pr: 460, verification: 'run', ended: NOW.toISOString(), sessions: [], actual: { tokens: null, minutes: null }, ts: NOW.toISOString() }])
  })

  it('w3: a probe closes with its report, resolved against the working directory', () => {
    const { deps, written } = world([startLine('7', 'probe')])
    expect(runTaskClose(['7', '--report', 'probe-7.md', '--verification', 'measurement'], { ...deps, cwd: REPORTS }).exitCode).toBe(0)
    expect(JSON.parse(written[0]!)).toMatchObject({ task: '7', report: `${REPORTS}/probe-7.md`, verification: 'measurement' })
    expect(JSON.parse(written[0]!)).not.toHaveProperty('pr')
  })

  it('w3: reads the last start line with a card for the id, past unreadable lines and lines without a card', () => {
    const { deps, written } = world(['{not json', JSON.stringify({ event: 'path', task: '9', path: 'cheap', ts: 'x' }), startLine('9', 'probe')])
    expect(runTaskClose(['9', '--report', `${REPORTS}/r.md`, '--verification', 'review'], deps).exitCode).toBe(0)
    expect(written).toHaveLength(1)
  })
})

const ENTRY_CONTRACT = 'implement · cheap · owner · touches not recorded on the card · law not recorded on the card'
const ENTRY_EXPECT = 'expect not recorded on the start line: its session is the window\'s CLAUDE_CODE_SESSION_ID, shared by every task the window runs, so no session is this task\'s alone'

function entryLine(id: string): string {
  return JSON.stringify({ event: 'entry', task: id, CONTRACT: ENTRY_CONTRACT, EXPECT: ENTRY_EXPECT, ACTION: 'a', RESULT: 'accepted · not started', ts: 'x' })
}

describe('the exit card repeats the entry card', () => {
  it('prints the entry\'s CONTRACT and EXPECT byte for byte and fills RESULT with the closing fact', () => {
    const { deps } = world([startLine('123', 'implement'), entryLine('123')])
    const result = runTaskClose(['123', '--pr', '460', '--verification', 'run'], deps)
    expect(result.stdout.slice(0, 5)).toEqual([
      expect.stringMatching(/^-{4} task:close #123 n -+$/),
      `CONTRACT | ${ENTRY_CONTRACT}`,
      `EXPECT   | ${ENTRY_EXPECT}`,
      'ACTION   | task:close #123 --pr 460 --verification run',
      `RESULT   | closed run · PR #460 · ${CARD_VERIFIED} written to ${deps.busPath} · forecast not recorded on the start line · actual tokens not recorded, minutes not recorded`,
    ])
  })

  it('the report carries the forecast and the actual tokens and minutes', () => {
    const started = (forecast?: unknown) => JSON.stringify({ ...JSON.parse(startLine('5', 'implement', WINDOW_SESSION)) as object, started: '2026-10-03T08:47:39.000Z', ...(forecast === undefined ? {} : { forecast }) })
    const resultOf = (line: string, extra: Partial<TaskCloseDeps> = {}) => {
      const { deps } = world([line], [sessionFile('-work', WINDOW_SESSION)])
      return runTaskClose(['5', '--pr', '9', '--verification', 'run'], { ...deps, tokens: () => 71_234, ...extra }).stdout[4]?.replace(deps.busPath!, '<bus>')
    }
    const where = `${CARD_VERIFIED} written to <bus>`
    expect(resultOf(started({ tokens: 68_352, minutes: 4.4105, class: 'implement/S', n: 8 }))).toBe(`RESULT   | closed run · PR #9 · ${where} · forecast tokens ≈ 68k, minutes ≈ 4.4 (class implement/S, n=8, start line) · actual tokens 71k, minutes 12.4`)
    expect(resultOf(started({ kind: 'none', class: 'implement/S', n: 2 }))).toBe(`RESULT   | closed run · PR #9 · ${where} · forecast none: n=2 for implement/S (start line) · actual tokens 71k, minutes 12.4`)
    const weighed: string[] = []
    const byWeight = (taskClass: string) => {
      weighed.push(taskClass)
      return { kind: 'forecast' as const, taskClass, n: 6, tokens: 50_000, minutes: 3 }
    }
    expect(resultOf(started(), { forecast: byWeight })).toBe(`RESULT   | closed run · PR #9 · ${where} · forecast tokens ≈ 50k, minutes ≈ 3 (class implement/S, n=6, median at close: the start line holds none) · actual tokens 71k, minutes 12.4`)
    expect(weighed).toEqual(['implement/S'])
  })

  it('a forecast read that throws is reported as not recorded and the closing still completes', () => {
    const line = JSON.stringify({ ...JSON.parse(startLine('5', 'implement', WINDOW_SESSION)) as object, started: '2026-10-03T08:47:39.000Z' })
    const { deps, written } = world([line], [sessionFile('-work', WINDOW_SESSION)])
    const failing = () => {
      throw new Error('bus.db is locked')
    }
    const result = runTaskClose(['5', '--pr', '9', '--verification', 'run'], { ...deps, tokens: () => 71_234, forecast: failing })
    expect(result.exitCode).toBe(0)
    expect(written).toHaveLength(1)
    expect(result.stdout[4]).toBe(`RESULT   | closed run · PR #9 · ${CARD_VERIFIED} written to ${deps.busPath} · forecast not recorded: the forecast read failed (bus.db is locked) · actual tokens 71k, minutes 12.4`)
  })

  it('names the contract and the forecast as not recorded when no entry line holds them', () => {
    const { deps } = world([startLine('123', 'implement')])
    const result = runTaskClose(['123', '--pr', '460', '--verification', 'run'], deps)
    expect(result.stdout[1]).toBe(`CONTRACT | contract not recorded in the bus ${deps.busPath}: no entry line for #123`)
    expect(result.stdout[2]).toBe(`EXPECT   | expect not recorded in the bus ${deps.busPath}: no entry line for #123`)
  })

  it('takes the entry line of its own task and the last of two', () => {
    const { deps } = world([startLine('123', 'implement'), entryLine('9'), entryLine('123').replace(ENTRY_CONTRACT, 'old'), entryLine('123')])
    expect(runTaskClose(['123', '--pr', '460', '--verification', 'run'], deps).stdout[1]).toBe(`CONTRACT | ${ENTRY_CONTRACT}`)
  })
})

describe('task:close records when the task ended and the sessions it used, each with the project key its file lies under', () => {
  it('records the window session under the key of the directory the window runs in, not the task worktree', () => {
    const { deps, written } = world([startLine('5', 'implement', WINDOW_SESSION)], [sessionFile('-work', WINDOW_SESSION)])
    const result = runTaskClose(['5', '--pr', '9', '--verification', 'run'], deps)
    expect(JSON.parse(written[0]!)).toMatchObject({ ended: NOW.toISOString(), sessions: [{ id: WINDOW_SESSION, project: '-work' }] })
    expect(result.stdout).toHaveLength(5)
  })

  it('records the start session and a different closing session once each, found under the cwd or the task worktree', () => {
    const { deps, written } = world([startLine('5', 'implement', 'opened')], [sessionFile('-mc-5', 'opened'), sessionFile('-work', 'closing')])
    expect(runTaskClose(['5', '--pr', '9', '--verification', 'run'], { ...deps, session: 'closing' }).exitCode).toBe(0)
    expect(JSON.parse(written[0]!)).toMatchObject({ sessions: [{ id: 'opened', project: '-mc-5' }, { id: 'closing', project: '-work' }] })
    const again = world([startLine('5', 'implement', 'same')], [sessionFile('-work', 'same')])
    runTaskClose(['5', '--pr', '9', '--verification', 'run'], { ...again.deps, session: 'same' })
    expect(JSON.parse(again.written[0]!)).toMatchObject({ sessions: [{ id: 'same', project: '-work' }] })
  })

  it('records a session whose file it cannot find without a project and names it as not recorded', () => {
    const { deps, written } = world([startLine('5', 'implement', WINDOW_SESSION)])
    const result = runTaskClose(['5', '--pr', '9', '--verification', 'run'], deps)
    expect(JSON.parse(written[0]!)).toMatchObject({ sessions: [{ id: WINDOW_SESSION }] })
    expect(result.stdout[5]).toBe(`[task:close] #5 session ${WINDOW_SESSION} project not recorded: no session file under -work or -mc-5 in ${PROJECTS}`)
  })

  it('names the sessions as not recorded when neither the start line nor the closing window carries one', () => {
    const { deps } = world([startLine('5', 'implement')])
    expect(runTaskClose(['5', '--pr', '9', '--verification', 'run'], deps).stdout[5]).toBe('[task:close] #5 sessions not recorded on the start line or in CLAUDE_CODE_SESSION_ID')
  })
})

const STARTED = '2026-10-03T08:54:30.000Z'
const TOKENS: Record<string, number | null> = { 'opened': 1000, 'closing': 2500, 'ghost-session': 4000, 'gone': null }

function startedLine(id: string, contour: 'cheap' | 'ladder', session: string): string {
  const line = JSON.parse(startLine(id, 'implement', session)) as { card: object }
  return JSON.stringify({ ...line, path: contour, started: STARTED, card: { ...line.card, contour } })
}

function countedTokens(session: { id: string }): number | null {
  return TOKENS[session.id] ?? null
}

describe('task:close records the actual tokens and minutes on the end line, so the reader restores nothing', () => {
  it('the end line records the actual tokens and minutes', () => {
    const { deps, written } = world([startedLine('5', 'cheap', 'opened')], [sessionFile('-mc-5', 'opened'), sessionFile('-work', 'closing')])
    expect(runTaskClose(['5', '--pr', '9', '--verification', 'run'], { ...deps, session: 'closing', tokens: countedTokens }).exitCode).toBe(0)
    expect(JSON.parse(written[0]!)).toMatchObject({ actual: { tokens: 3500, minutes: 5.5 } })
  })

  it('a ladder card counts the session of its Ghost run from the task line, once', () => {
    const files = [sessionFile('-mc-5', 'opened'), sessionFile('-mc-5', LAUNCH_SESSION)]
    const { deps, written } = world([startedLine('5', 'ladder', 'opened'), launchTaskLine('5')], files)
    runTaskClose(['5', '--pr', '9', '--verification', 'run'], { ...deps, tokens: countedTokens })
    expect(JSON.parse(written[0]!)).toMatchObject({ sessions: [{ id: 'opened', project: '-mc-5' }], actual: { tokens: 5000, minutes: 5.5 } })
    const cheap = world([startedLine('5', 'cheap', 'opened'), launchTaskLine('5')], files)
    runTaskClose(['5', '--pr', '9', '--verification', 'run'], { ...cheap.deps, tokens: countedTokens })
    expect(JSON.parse(cheap.written[0]!)).toMatchObject({ actual: { tokens: 1000 } })
  })

  it('an unreadable session makes the actual tokens unknown', () => {
    const unreadable = world([startedLine('5', 'cheap', 'opened')], [sessionFile('-mc-5', 'opened'), sessionFile('-work', 'gone')])
    runTaskClose(['5', '--pr', '9', '--verification', 'run'], { ...unreadable.deps, session: 'gone', tokens: countedTokens })
    expect(JSON.parse(unreadable.written[0]!)).toMatchObject({ actual: { tokens: null, minutes: 5.5 } })
    const unplaced = world([startedLine('5', 'cheap', 'opened')], [sessionFile('-mc-5', 'opened')])
    runTaskClose(['5', '--pr', '9', '--verification', 'run'], { ...unplaced.deps, session: 'closing', tokens: countedTokens })
    expect(JSON.parse(unplaced.written[0]!)).toMatchObject({ actual: { tokens: null } })
  })

  it('records the actual as unknown, never 0, when no session or no start time is recorded', () => {
    const { deps, written } = world([startLine('5', 'implement')])
    runTaskClose(['5', '--pr', '9', '--verification', 'run'], { ...deps, tokens: () => 0 })
    expect(JSON.parse(written[0]!)).toMatchObject({ actual: { tokens: null, minutes: null } })
  })
})

function launchEntryLine(id: string, kind: 'implement' | 'probe' = 'implement'): string {
  const decision = kind === 'probe' ? 'none' : 'owner'
  return JSON.stringify({ event: 'entry', task: id, CONTRACT: ENTRY_CONTRACT, EXPECT: ENTRY_EXPECT, ACTION: 'a', RESULT: 'accepted · not started', ts: 'entry-ts', card: { id: Number(id), name: 'launched', kind, milestone: 'ghosts', size: 'S', contour: 'ladder', decision, depends: [], blocks: [], line: 'l' } })
}

function launchTaskLine(id: string): string {
  return JSON.stringify({ event: 'task', ts: 'task-ts', task: id, session: LAUNCH_SESSION, ladder: 'done' })
}

describe('task:close closes a ghosts:launch run by the lines the launcher wrote, with no task:start line', () => {
  it('closes by --pr, taking the card from the entry line and the session from the task line', () => {
    const { deps, written } = world([launchEntryLine('160'), launchTaskLine('160')], [sessionFile('-work', LAUNCH_SESSION)])
    const result = runTaskClose(['160', '--pr', '518', '--verification', 'review'], { ...deps, tokens: () => 700 })
    expect(result.exitCode).toBe(0)
    expect(written.map(text => JSON.parse(text) as unknown)).toEqual([{ event: 'path', task: '160', path: 'ladder', pr: 518, verification: 'review', ended: NOW.toISOString(), sessions: [{ id: LAUNCH_SESSION, project: '-work' }], actual: { tokens: 700, minutes: null }, ts: NOW.toISOString() }])
    expect(result.stdout[0]).toMatch(/^-{4} task:close #160 launched -+$/)
  })

  it('writes no time field the launcher lines did not carry', () => {
    const { deps, written } = world([launchEntryLine('160'), launchTaskLine('160')])
    runTaskClose(['160', '--pr', '518', '--verification', 'review'], deps)
    const line = JSON.parse(written[0]!) as Record<string, unknown>
    expect(line).not.toHaveProperty('started')
    expect(Object.values(line)).not.toContain('entry-ts')
    expect(Object.values(line)).not.toContain('task-ts')
  })

  it('still closes a launched probe only through --report', () => {
    const { deps, written } = world([launchEntryLine('8', 'probe')])
    expect(runTaskClose(['8', '--pr', '518', '--verification', 'run'], deps).stderr).toEqual(['[task:close] #8 is kind probe, which closes with --report only; nothing written'])
    expect(written).toEqual([])
  })

  it('prefers the task:start line when the task has one', () => {
    const { deps, written } = world([startLine('160', 'implement'), launchEntryLine('160')])
    runTaskClose(['160', '--pr', '518', '--verification', 'run'], deps)
    expect(JSON.parse(written[0]!)).toMatchObject({ path: 'cheap' })
  })

  it('refuses an entry line without a card, as before the launcher carried one', () => {
    const { deps, written } = world([entryLine('160'), launchTaskLine('160')])
    expect(runTaskClose(['160', '--pr', '518', '--verification', 'run'], deps).stderr[0]).toContain('have no task:start line with a card for #160')
    expect(written).toEqual([])
  })
})

function judgedLine(card: string, id: string, outcome: string, matched: boolean): string {
  return JSON.stringify({ event: 'mutation-judged', card, id, outcome, matched, ts: 'x' })
}

describe('task:close confirms mutation only on judged lines where no mutant survived', () => {
  it('refuses mutation without a mutation-judged line for the card', () => {
    const { deps, written } = world([startLine('123', 'implement'), judgedLine('9', 'M1', 'named-red', true)])
    const result = runTaskClose(['123', '--pr', '460', '--verification', 'mutation'], deps)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toEqual([`[task:close] --verification mutation needs a mutation-judged line for #123 in the bus ${deps.busPath}, and there is none; nothing written`])
    expect(written).toEqual([])
  })

  it('refuses mutation on a nothing-red line, even when its prediction matched', () => {
    const { deps, written } = world([startLine('123', 'implement'), judgedLine('123', 'M1', 'named-red', true), judgedLine('123', 'M2', 'nothing-red', true), judgedLine('123', 'M3', 'other-red', false)])
    const result = runTaskClose(['123', '--pr', '460', '--verification', 'mutation'], deps)
    expect(result.stderr).toEqual([`[task:close] --verification mutation refused: M2 of #123 survived (outcome nothing-red) in the bus ${deps.busPath}; nothing written`])
    expect(written).toEqual([])
  })

  it('closes with mutation when every judged line of the card was red, whether or not it matched', () => {
    const { deps, written } = world([startLine('123', 'implement'), judgedLine('123', 'M1', 'named-red', true), judgedLine('123', 'M2', 'other-red', false), judgedLine('9', 'M1', 'nothing-red', true)])
    expect(runTaskClose(['123', '--pr', '460', '--verification', 'mutation'], deps).exitCode).toBe(0)
    expect(JSON.parse(written[0]!)).toMatchObject({ task: '123', verification: 'mutation' })
  })

  it('a later named-red verdict of the same mutation replaces its earlier survived', () => {
    const { deps, written } = world([startLine('665', 'implement'), judgedLine('665', 'M1', 'named-red', true), judgedLine('665', 'M4', 'nothing-red', true), judgedLine('665', 'M4b', 'named-red', true)])
    expect(runTaskClose(['665', '--pr', '618', '--verification', 'mutation'], deps).exitCode).toBe(0)
    expect(JSON.parse(written[0]!)).toMatchObject({ task: '665', verification: 'mutation' })
  })

  it('refuses when the latest verdict of a mutation survived, even after an earlier red one', () => {
    const { deps, written } = world([startLine('665', 'implement'), judgedLine('665', 'M4', 'named-red', true), judgedLine('665', 'M4b', 'nothing-red', true)])
    const result = runTaskClose(['665', '--pr', '618', '--verification', 'mutation'], deps)
    expect(result.stderr).toEqual([`[task:close] --verification mutation refused: M4b of #665 survived (outcome nothing-red) in the bus ${deps.busPath}; nothing written`])
    expect(written).toEqual([])
  })

  it('does not let a red verdict of one mutation replace a survived one of another', () => {
    const { deps, written } = world([startLine('665', 'implement'), judgedLine('665', 'M4', 'nothing-red', true), judgedLine('665', 'M14', 'named-red', true)])
    expect(runTaskClose(['665', '--pr', '618', '--verification', 'mutation'], deps).exitCode).toBe(1)
    expect(written).toEqual([])
  })

  it('reads a rerun only as a numbered id with a lowercase suffix, so a named-red noop does not replace a survived guard', () => {
    const { deps, written } = world([startLine('665', 'implement'), judgedLine('665', 'guard', 'nothing-red', true), judgedLine('665', 'noop', 'named-red', true)])
    expect(runTaskClose(['665', '--pr', '618', '--verification', 'mutation'], deps).exitCode).toBe(1)
    expect(written).toEqual([])
  })

  it('leaves the other words to the report, without asking for judged lines', () => {
    const { deps } = world([startLine('123', 'implement')])
    expect(runTaskClose(['123', '--pr', '460', '--verification', 'review'], deps).exitCode).toBe(0)
  })
})

const SHIFT = '/shift/2026-10-06-1747'
const REPORT = path.join(SHIFT, 'report-123.md')

function stopLine(id: string, shift: string): string {
  return JSON.stringify({ event: 'stop', task: id, at: 'question', why: 'w', worktree: `/mc-${id}`, shift, session: 's', ts: 'x' })
}

function shiftReport(word: string): string {
  return `#123 n [implement/ghosts/S/cheap/owner]\nresult: done\nPR #460\nverification: ${word}\nchecked by a run\n`
}

describe('task:close holds the flag to the verification word of the card\'s shift report', () => {
  it('refuses a verification the report contradicts and names both words', () => {
    const { deps, written } = world([startLine('123', 'implement'), stopLine('123', SHIFT), judgedLine('123', 'M1', 'named-red', true)], [], { [REPORT]: shiftReport('run') })
    const result = runTaskClose(['123', '--pr', '460', '--verification', 'mutation'], deps)
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toEqual([`[task:close] the shift report ${REPORT} says verification: run, the flag says mutation; close with --verification run, or pass --override-report <reason> to keep mutation; nothing written`])
    expect(written).toEqual([])
  })

  it('closes when the report and the flag agree', () => {
    const { deps, written } = world([startLine('123', 'implement'), stopLine('123', SHIFT)], [], { [REPORT]: shiftReport('run') })
    expect(runTaskClose(['123', '--pr', '460', '--verification', 'run'], deps).exitCode).toBe(0)
    expect(JSON.parse(written[0]!)).not.toHaveProperty('override')
  })

  it('reads the shift directory a start line names when no stop line does', () => {
    const start = JSON.stringify({ ...JSON.parse(startLine('123', 'implement')) as object, shift: SHIFT })
    const { deps } = world([start], [], { [REPORT]: shiftReport('review') })
    expect(runTaskClose(['123', '--pr', '460', '--verification', 'run'], deps).stderr[0]).toContain('says verification: review, the flag says run')
  })

  it('closes against the report with an override and records its reason', () => {
    const { deps, written } = world([startLine('123', 'implement'), stopLine('123', SHIFT)], [], { [REPORT]: shiftReport('run') })
    const result = runTaskClose(['123', '--pr', '460', '--verification', 'review', '--override-report', 'reviewed after the shift'], deps)
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(written[0]!)).toMatchObject({ verification: 'review', override: 'reviewed after the shift' })
    expect(result.stdout[3]).toBe('ACTION   | task:close #123 --pr 460 --verification review --override-report reviewed after the shift')
  })

  it('does not lift the mutation refusal with an override', () => {
    const { deps, written } = world([startLine('123', 'implement'), stopLine('123', SHIFT)], [], { [REPORT]: shiftReport('mutation') })
    expect(runTaskClose(['123', '--pr', '460', '--verification', 'mutation', '--override-report', 'r'], deps).stderr[0]).toContain('needs a mutation-judged line')
    expect(written).toEqual([])
  })

  it('closes when no line names a shift, or the named report is missing or has no verification line', () => {
    expect(runTaskClose(['123', '--pr', '460', '--verification', 'run'], world([startLine('123', 'implement')], [], { [REPORT]: shiftReport('review') }).deps).exitCode).toBe(0)
    expect(runTaskClose(['123', '--pr', '460', '--verification', 'run'], world([startLine('123', 'implement'), stopLine('123', SHIFT)]).deps).exitCode).toBe(0)
    expect(runTaskClose(['123', '--pr', '460', '--verification', 'run'], world([startLine('123', 'implement'), stopLine('123', SHIFT)], [], { [REPORT]: 'result: stopped\n' }).deps).exitCode).toBe(0)
  })
})

describe('w3: task:close refuses and writes nothing', () => {
  it.each([
    ['no verification', ['123', '--pr', '460'], `--verification is required: one of ${VERIFICATION_WORDS.join(', ')}`],
    ['a word outside VERIFICATION_WORDS', ['123', '--pr', '460', '--verification', 'vibes'], `verification 'vibes' is not one of`],
    ['implement closed with a report', ['123', '--report', 'r.md', '--verification', 'run'], '#123 is kind implement, which closes with --pr only'],
    ['implement with both', ['123', '--pr', '460', '--report', 'r.md', '--verification', 'run'], '#123 is kind implement, which closes with --pr only'],
    ['a PR that is not a number', ['123', '--pr', 'PR#460', '--verification', 'run'], `--pr 'PR#460' is not a pull request number`],
    ['no start line with a card', ['55', '--pr', '460', '--verification', 'run'], 'have no task:start line with a card for #55'],
    ['an unknown flag', ['123', '--sha', 'abc', '--verification', 'run'], 'unknown flag --sha'],
    ['an override without a reason', ['123', '--pr', '460', '--verification', 'run', '--override-report'], '--override-report needs a value'],
  ])('refuses %s', (_, argv, reason) => {
    const { deps, written } = world([startLine('123', 'implement'), JSON.stringify({ event: 'path', task: '55', path: 'cheap', ts: 'x' })])
    const result = runTaskClose(argv, deps)
    expect(result.exitCode).toBe(1)
    expect(result.stderr[0]).toContain(reason)
    expect(written).toEqual([])
  })

  it('w3: refuses a probe closed with --pr', () => {
    const { deps, written } = world([startLine('7', 'probe')])
    expect(runTaskClose(['7', '--pr', '460', '--verification', 'run'], deps).stderr).toEqual(['[task:close] #7 is kind probe, which closes with --report only; nothing written'])
    expect(written).toEqual([])
  })

  it('refuses when the bus holds no journal line and no card.started', () => {
    const { deps } = world([])
    expect(runTaskClose(['1', '--pr', '2', '--verification', 'run'], deps).exitCode).toBe(1)
  })
})

describe('the card line of the pull request body', () => {
  const prBodyOf = (body: string | null) => (): GhRead<string | null> => read(body)

  it('warns when the body does not open with the card line, and still closes', () => {
    const { deps, written } = world([startLine('123', 'implement')])
    const result = runTaskClose(['123', '--pr', '460', '--verification', 'run'], { ...deps, prBody: prBodyOf('not a card\n\nbody') })
    expect(result.exitCode).toBe(0)
    expect(written).toHaveLength(1)
    expect(result.stderr).toEqual([expect.stringContaining('warning: the body of PR #460 does not open with the card line')])
  })

  it('says nothing when the body opens with the card line', () => {
    const { deps } = world([startLine('123', 'implement')])
    const body = '#123 n [implement/ghosts/S/cheap/owner] · depends — · blocks —\n\nbody'
    expect(runTaskClose(['123', '--pr', '460', '--verification', 'run'], { ...deps, prBody: prBodyOf(body) }).stderr).toEqual([])
  })

  it('says nothing when the card line opens with card: ', () => {
    const { deps } = world([startLine('123', 'implement')])
    const body = 'card: #123 n [implement/ghosts/S/cheap/owner] · depends — · blocks —\n\nbody'
    expect(runTaskClose(['123', '--pr', '460', '--verification', 'run'], { ...deps, prBody: prBodyOf(body) }).stderr).toEqual([])
  })

  it('refuses a body that cannot be read and writes nothing', () => {
    const { deps, written } = world([startLine('123', 'implement')])
    const result = runTaskClose(['123', '--pr', '460', '--verification', 'run'], { ...deps, prBody: () => unread('gh: no network') })
    expect(result.exitCode).toBe(1)
    expect(written).toEqual([])
    expect(result.stderr).toEqual(['[task:close] the body of PR #460 was not read, so whose result it is was not checked: gh: no network; nothing written'])
  })

  it('refuses when there is no reader of the PR body', () => {
    const { deps, written } = world([startLine('123', 'implement')])
    const result = runTaskClose(['123', '--pr', '460', '--verification', 'run'], { ...deps, prBody: undefined as unknown as TaskCloseDeps['prBody'] })
    expect(result.exitCode).toBe(1)
    expect(written).toEqual([])
    expect(result.stderr[0]).toContain('the body of PR #460 was not read')
  })

  it('refuses a PR whose card line names another card and leaves the journal as it was', () => {
    const { deps, written } = world([startLine('889', 'implement')])
    const closed: number[] = []
    const result = runTaskClose(['889', '--pr', '786', '--verification', 'run'], {
      ...deps,
      prBody: prBodyOf('#855 card-automaton-folds [implement/netwatch/S/cheap/auto] · depends — · blocks —\n\nbody'),
      openIssue: () => read({ title: 'n', body: null }),
      closeIssue: (issue) => {
        closed.push(issue)
        return ran('')
      },
    })
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toEqual([])
    expect(result.stderr).toEqual(['[task:close] PR #786 opens with the card line of #855, not #889: it is that card\'s result; a pull request an owner decision shares between both cards closes with --shared-by D-<N>; nothing written'])
    expect(written).toEqual([])
    expect(closed).toEqual([])
  })
})

describe('a PR shared by an owner decision', () => {
  const DECISIONS = '/owner-decisions.md'
  const ARCHIVE = '/owner-decisions.archive.md'
  const SHARED_BODY = '#534 atlas-command [implement/engram/M/cheap/auto] · depends — · blocks —\n\nCards #533 and #532 close when this pull request merges'
  const D33 = '- D-33 · 2026-10-08 — #532 and #533 are product (Atlas). Both entered main with #534 (PR #642, c4a579e). · superseded-by D-54'
  const D40 = '- D-40 · 2026-10-08 — #532 waits for the renderer of PR #534. · card #532'

  function shared(argv: string[], files: Record<string, string> = { [ARCHIVE]: `# Owner decisions archive\n\n${D33}\n` }): { result: ReturnType<typeof runTaskClose>, written: string[] } {
    const { deps, written } = world([startLine('532', 'implement')], [], files)
    return { result: runTaskClose(['532', '--pr', '642', ...argv, '--verification', 'review'], { ...deps, prBody: () => read(SHARED_BODY), decisionsFile: DECISIONS }), written }
  }

  it('closes on a decision in the archive that names both cards, and records it on the path line', () => {
    const { result, written } = shared(['--shared-by', 'D-33'])
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(written[0]!)).toMatchObject({ event: 'path', task: '532', pr: 642, sharedBy: 'D-33', verification: 'review' })
    expect(result.stdout[3]).toBe('ACTION   | task:close #532 --pr 642 --shared-by D-33 --verification review')
  })

  it('closes on a decision in force that names both cards', () => {
    const { result, written } = shared(['--shared-by', 'D-33'], { [DECISIONS]: `# Owner decisions\n\n${D33.replace(' · superseded-by D-54', '')}\n` })
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(written[0]!)).toMatchObject({ sharedBy: 'D-33' })
  })

  it.each([
    ['without --shared-by', [], 'PR #642 opens with the card line of #534, not #532'],
    ['a decision that names only one of the cards, PR #534 not counted as a card', ['--shared-by', 'D-40'], '--shared-by D-40 does not name #532 and #534'],
    ['a decision that is not recorded', ['--shared-by', 'D-41'], `--shared-by D-41: no decision D-41 in ${DECISIONS} or ${ARCHIVE}`],
    ['a reference that is no decision number', ['--shared-by', '33'], '--shared-by \'33\' is not an owner decision D-<N>'],
  ])('refuses %s and writes nothing', (_, argv, reason) => {
    const { result, written } = shared(argv, { [ARCHIVE]: `${D33}\n${D40}\n` })
    expect(result.exitCode).toBe(1)
    expect(result.stderr[0]).toContain(reason)
    expect(written).toEqual([])
  })

  it('refuses --shared-by on a PR whose body has no card line, and on a probe closed by its report', () => {
    const { deps, written } = world([startLine('532', 'implement'), startLine('7', 'probe')], [], { [ARCHIVE]: `${D33}\n` })
    const decided = { ...deps, decisionsFile: DECISIONS }
    expect(runTaskClose(['532', '--pr', '642', '--shared-by', 'D-33', '--verification', 'run'], decided).stderr[0]).toContain('PR #642 opens with no card line, so no card shares it with #532')
    expect(runTaskClose(['7', '--report', 'r.md', '--shared-by', 'D-33', '--verification', 'run'], decided).stderr[0]).toContain('--shared-by shares a pull request, and #7 closes with --report')
    expect(written).toEqual([])
  })

  it('refuses --shared-by when no decisions file is given', () => {
    const { deps, written } = world([startLine('532', 'implement')])
    expect(runTaskClose(['532', '--pr', '642', '--shared-by', 'D-33', '--verification', 'run'], { ...deps, prBody: () => read(SHARED_BODY) }).stderr[0]).toContain('no decisions file is given')
    expect(written).toEqual([])
  })
})

describe('task:close closes the GitHub issue of its card', () => {
  function issues(open: Record<number, OpenIssue>): { closed: [number, string][], deps: Pick<TaskCloseDeps, 'openIssue' | 'closeIssue'> } {
    const closed: [number, string][] = []
    return { closed, deps: { openIssue: number => read(open[number] ?? null), closeIssue: (number, comment) => {
      closed.push([number, comment])
      return ran('')
    } } }
  }

  it('task:close closes the issue of its card with a link to the PR', () => {
    const { deps } = world([startLine('123', 'implement')])
    const github = issues({ 123: { title: 'n: the thing to do', body: null } })
    const result = runTaskClose(['123', '--pr', '460', '--verification', 'run'], { ...deps, ...github.deps })
    expect(result.exitCode).toBe(0)
    expect(github.closed).toEqual([[123, 'Closed by task:close #123 n: PR #460.']])
    expect(result.stdout.at(-1)).toBe('[task:close] issue #123 closed with a comment naming PR #460')
  })

  it('closes an issue whose body says card #N, and names the report of a probe', () => {
    const { deps } = world([startLine('7', 'probe')])
    const github = issues({ 7: { title: 'something else entirely', body: 'parked as card #7, see the board' } })
    runTaskClose(['7', '--report', 'probe-7.md', '--verification', 'measurement'], { ...deps, ...github.deps, cwd: REPORTS })
    expect(github.closed).toEqual([[7, `Closed by task:close #7 n: report ${REPORTS}/probe-7.md.`]])
  })

  it('an issue with the same number about another card stays open and is named', () => {
    const { deps, written } = world([startLine('594', 'implement')])
    const title = 'ladder-release-only-hash-stop (was parking card #630)'
    const github = issues({ 594: { title, body: 'card #5940 and card #630' } })
    const result = runTaskClose(['594', '--pr', '700', '--verification', 'run'], { ...deps, ...github.deps })
    expect(result.exitCode).toBe(0)
    expect(written).toHaveLength(1)
    expect(github.closed).toEqual([])
    expect(result.stdout.at(-1)).toBe(`[task:close] issue #594 '${title}' is about another card, not n; left open`)
  })

  it('does not take a slug that only contains the card name for the card name', () => {
    const { deps } = world([startLine('123', 'implement')])
    const github = issues({ 123: { title: 'n-other', body: null } })
    runTaskClose(['123', '--pr', '460', '--verification', 'run'], { ...deps, ...github.deps })
    expect(github.closed).toEqual([])
  })

  it('says nothing when no open issue carries the card number', () => {
    const { deps } = world([startLine('123', 'implement')])
    const github = issues({})
    const result = runTaskClose(['123', '--pr', '460', '--verification', 'run'], { ...deps, ...github.deps })
    expect(github.closed).toEqual([])
    expect(result.stdout).toHaveLength(6)
  })

  it('still closes the task when the issue cannot be read or closed, and names it', () => {
    const { deps, written } = world([startLine('123', 'implement')])
    const notRead = runTaskClose(['123', '--pr', '460', '--verification', 'run'], { ...deps, openIssue: () => unread('gh: no network'), closeIssue: () => ran('') })
    expect(notRead.exitCode).toBe(0)
    expect(notRead.stdout.at(-1)).toBe('[task:close] issue #123 not read, left as it is: gh: no network')
    const unclosed = runTaskClose(['123', '--pr', '460', '--verification', 'run'], { ...deps, now: () => new Date(NOW.getTime() + 1000), openIssue: () => read({ title: 'n', body: null }), closeIssue: () => failed('gh: forbidden') })
    expect(unclosed.exitCode).toBe(0)
    expect(unclosed.stdout.at(-1)).toBe('[task:close] issue #123 not closed: gh: forbidden; re-run task:close #123 to close it')
    expect(written).toHaveLength(2)
  })
})

describe('task:close reads the start of a task from card.started in the bus', () => {
  const card = { id: 891, name: 'path-line-readers-read-card-started', kind: 'implement', milestone: 'netwatch', size: 'M', contour: 'ladder', decision: 'auto', depends: [], blocks: [836], line: 'l' }
  const started = { path: 'ladder', started: '2026-10-03T08:30:00.000Z', session: 'start-session', shift: '/shift/a', worktree: '/mc-891', branch: 'feat/891', card }

  it('task:close finds the start of a task from card.started in the bus', () => {
    const bus = busWithCardStarted([{ cardId: 891, ts: started.started, payload: started }])
    try {
      const { deps } = world([])
      const result = runTaskClose(['891', '--pr', '790', '--verification', 'run'], { ...deps, busPath: bus.file })
      expect(result.exitCode).toBe(0)
      expect(JSON.parse(closingLines(bus.file)[0]!)).toMatchObject({ event: 'path', task: '891', path: 'ladder', pr: 790, sessions: [{ id: 'start-session' }], actual: { minutes: 30 } })
    }
    finally {
      bus.remove()
    }
  })

  it('finds the start of a card started before the cutoff with an empty journal', () => {
    const bus = busWithCardStarted([])
    const db = openBus(bus.file)
    try {
      appendEvent(db, legacyEventOf(startLine('892', 'implement').replace('"ts":"x"', '"ts":"2026-10-03T08:30:00.000Z"'), 1)!)
    }
    finally {
      db.close()
    }
    try {
      const { deps } = world([])
      const result = runTaskClose(['892', '--pr', '791', '--verification', 'run'], { ...deps, busPath: bus.file })
      expect(result.exitCode).toBe(0)
      expect(JSON.parse(closingLines(bus.file)[0]!)).toMatchObject({ event: 'path', task: '892', path: 'cheap', pr: 791 })
    }
    finally {
      bus.remove()
    }
  })

  it('prefers card.started over an earlier path line of the same card', () => {
    const bus = busWithCardStarted([{ cardId: 123, ts: started.started, payload: { ...started, path: 'ladder', card: { ...card, id: 123 } } }])
    try {
      const { deps } = world([startLine('123', 'implement')])
      expect(runTaskClose(['123', '--pr', '460', '--verification', 'run'], { ...deps, busPath: bus.file }).exitCode).toBe(0)
      expect(JSON.parse(closingLines(bus.file)[0]!)).toMatchObject({ path: 'ladder' })
    }
    finally {
      bus.remove()
    }
  })

  it('checks the verification word against the report of the shift card.started names', () => {
    const bus = busWithCardStarted([{ cardId: 891, ts: started.started, payload: started }])
    try {
      const { deps } = world([], [], { [path.join('/shift/a', 'report-891.md')]: 'verification: review\n' })
      expect(runTaskClose(['891', '--pr', '790', '--verification', 'run'], { ...deps, busPath: bus.file }).stderr[0]).toContain('the shift report /shift/a/report-891.md says verification: review')
    }
    finally {
      bus.remove()
    }
  })

  it('task:close with --report closes a card started by the launch node', () => {
    const bus = busWithCardStarted([{ cardId: 1102, ts: '2026-10-19T18:21:34.972Z', payload: { session: '4fc53af7', worktree: '/mc-1102', branch: 'feat/1102', base: 'b'.repeat(40), pid: 35772, pgid: 35772, contour: 'cheap' } }])
    const db = openBus(bus.file)
    try {
      appendEvent(db, { ts: '2026-10-19T18:21:29.660Z', type: 'card.admitted', actor: 'worker:intake:t', cardId: 1102, pr: null, head: null, dedupeKey: 'card.admitted:1102', payload: { card: '#1102 a-probe [probe/netwatch/S/cheap/none] · depends — · blocks —', lane: 'lane-a', contour: 'cheap' }, legacy: false })
    }
    finally {
      db.close()
    }
    try {
      const { deps } = world([])
      const result = runTaskClose(['1102', '--report', 'probe-1102.md', '--verification', 'run'], { ...deps, cwd: REPORTS, busPath: bus.file })
      expect(result.stderr).toEqual([])
      expect(result.exitCode).toBe(0)
      expect(JSON.parse(closingLines(bus.file)[0]!)).toMatchObject({ event: 'path', task: '1102', path: 'cheap', report: `${REPORTS}/probe-1102.md`, verification: 'run', sessions: [{ id: '4fc53af7' }] })
    }
    finally {
      bus.remove()
    }
  })

  it('task:close takes the card of the last admission that carries one, past a session-end re-admission and a backfill row', () => {
    const bus = busWithCardStarted([{ cardId: 1102, ts: '2026-10-19T18:21:34.972Z', payload: { session: '4fc53af7', worktree: '/mc-1102', branch: 'feat/1102', base: 'b'.repeat(40), pid: 35772, pgid: 35772, contour: 'cheap' } }])
    const db = openBus(bus.file)
    const admitted = (key: string, payload: Record<string, unknown>): void => {
      appendEvent(db, { ts: '2026-10-19T18:21:29.660Z', type: 'card.admitted', actor: 'worker:intake:t', cardId: 1102, pr: null, head: null, dedupeKey: `card.admitted:${key}`, payload, legacy: false })
    }
    try {
      admitted('1102', { card: '#1102 a-probe [probe/netwatch/S/cheap/none] · depends — · blocks —', lane: 'lane-a', contour: 'cheap' })
      admitted('1102:session-end', { lane: 'lane-a', decision: 'auto', contour: 'cheap', depends: [], admission: 'session-end:card.started:launch:1102' })
      admitted('1102:backfill', { source: 'backfill', card: '#1102 an-implement [implement/netwatch/S/ladder/auto] · depends — · blocks —', lane: 'lane-a', contour: 'ladder' })
    }
    finally {
      db.close()
    }
    try {
      const { deps } = world([])
      const result = runTaskClose(['1102', '--report', 'probe-1102.md', '--verification', 'run'], { ...deps, cwd: REPORTS, busPath: bus.file })
      expect(result.stderr).toEqual([])
      expect(JSON.parse(closingLines(bus.file)[0]!)).toMatchObject({ event: 'path', task: '1102', path: 'cheap', report: `${REPORTS}/probe-1102.md`, sessions: [{ id: '4fc53af7' }] })
    }
    finally {
      bus.remove()
    }
  })

  it('task:close does not take a card-less card.started without a pid as the launch node start', () => {
    const bus = busWithCardStarted([{ cardId: 1102, ts: '2026-10-19T18:21:34.972Z', payload: { session: '4fc53af7', worktree: '/mc-1102', branch: 'feat/1102', base: 'b'.repeat(40), contour: 'cheap' } }])
    const db = openBus(bus.file)
    try {
      appendEvent(db, { ts: '2026-10-19T18:21:29.660Z', type: 'card.admitted', actor: 'worker:intake:t', cardId: 1102, pr: null, head: null, dedupeKey: 'card.admitted:1102', payload: { card: '#1102 a-probe [probe/netwatch/S/cheap/none] · depends — · blocks —', lane: 'lane-a', contour: 'cheap' }, legacy: false })
    }
    finally {
      db.close()
    }
    try {
      const { deps, written } = world([])
      const result = runTaskClose(['1102', '--report', 'probe-1102.md', '--verification', 'run'], { ...deps, cwd: REPORTS, busPath: bus.file })
      expect(result.exitCode).not.toBe(0)
      expect(result.stderr[0]).toContain(`and the bus ${bus.file} has no card.started with one`)
      expect(written).toEqual([])
    }
    finally {
      bus.remove()
    }
  })

  it('names the bus it read when neither the journal nor the bus holds a start', () => {
    const bus = busWithCardStarted([])
    try {
      const { deps } = world([])
      expect(runTaskClose(['891', '--pr', '790', '--verification', 'run'], { ...deps, busPath: bus.file }).stderr[0]).toContain(`and the bus ${bus.file} has no card.started with one`)
    }
    finally {
      bus.remove()
    }
  })

  it('prints CONTRACT and EXPECT from the entry of card.started when the journal has no entry line', () => {
    const entry = { schema: 2, CONTRACT: 'contract from the bus', EXPECT: 'expect from the bus', ACTION: 'a', RESULT: 'accepted · not started' }
    const bus = busWithCardStarted([{ cardId: 891, ts: started.started, payload: { ...started, entry } }])
    try {
      const { deps } = world([])
      const result = runTaskClose(['891', '--pr', '790', '--verification', 'run'], { ...deps, busPath: bus.file })
      expect(result.stdout.slice(1, 3)).toEqual(['CONTRACT | contract from the bus', 'EXPECT   | expect from the bus'])
    }
    finally {
      bus.remove()
    }
  })

  it('takes the entry of card.started before an entry line of the journal', () => {
    const entry = { schema: 2, CONTRACT: 'contract from the bus', EXPECT: 'expect from the bus', ACTION: 'a', RESULT: 'accepted · not started' }
    const bus = busWithCardStarted([{ cardId: 123, ts: started.started, payload: { ...started, card: { ...card, id: 123 }, entry } }])
    try {
      const { deps } = world([entryLine('123')])
      expect(runTaskClose(['123', '--pr', '460', '--verification', 'run'], { ...deps, busPath: bus.file }).stdout[1]).toBe('CONTRACT | contract from the bus')
    }
    finally {
      bus.remove()
    }
  })

  it('takes the entry of the last card.started of a restarted card', () => {
    const entry = { schema: 2, CONTRACT: 'first contract', EXPECT: 'e', ACTION: 'a', RESULT: 'accepted · not started' }
    const bus = busWithCardStarted([
      { cardId: 891, ts: started.started, payload: { ...started, entry } },
      { cardId: 891, ts: started.started, payload: { ...started, entry: { ...entry, CONTRACT: 'restarted contract' } } },
    ])
    try {
      const { deps } = world([])
      expect(runTaskClose(['891', '--pr', '790', '--verification', 'run'], { ...deps, busPath: bus.file }).stdout[1]).toBe('CONTRACT | restarted contract')
    }
    finally {
      bus.remove()
    }
  })

  it('names the bus as not holding the contract when card.started carries no entry', () => {
    const bus = busWithCardStarted([{ cardId: 891, ts: started.started, payload: started }])
    try {
      const { deps } = world([])
      const result = runTaskClose(['891', '--pr', '790', '--verification', 'run'], { ...deps, busPath: bus.file })
      expect(result.stdout.slice(1, 3)).toEqual([
        `CONTRACT | contract not recorded in the bus ${bus.file}: no entry line for #891`,
        `EXPECT   | expect not recorded in the bus ${bus.file}: no entry line for #891`,
      ])
    }
    finally {
      bus.remove()
    }
  })
})

describe('task:close takes whose result a PR is from prs.card_id in the bus', () => {
  const noCardLine = (): GhRead<string | null> => read('not a card\n\nbody')

  it('witness 5: task:close #889 --pr 786 is refused by prs.card_id = 855 though the PR body has no card line', () => {
    const { deps, written } = world([startLine('889', 'implement')])
    const result = runTaskClose(['889', '--pr', '786', '--verification', 'run'], { ...deps, prBody: noCardLine, prCard: pr => pr === 786 ? 855 : null })
    expect(result.exitCode).toBe(1)
    expect(written).toEqual([])
    expect(result.stderr).toEqual(['[task:close] PR #786 belongs to #855 in the bus (prs.card_id), not #889: it is that card\'s result; a pull request an owner decision shares between both cards closes with --shared-by D-<N>; nothing written'])
  })

  it('refuses a PR with no prs row and no card line in its body, instead of warning', () => {
    const { deps, written } = world([startLine('123', 'implement')])
    const result = runTaskClose(['123', '--pr', '460', '--verification', 'run'], { ...deps, prBody: noCardLine, prCard: () => null })
    expect(result.exitCode).toBe(1)
    expect(written).toEqual([])
    expect(result.stderr[0]).toContain('PR #460 has no prs row in the bus and its body opens with no card line')
  })

  it('closes a PR whose prs row names the card, and still warns that its body has no card line', () => {
    const { deps, written } = world([startLine('123', 'implement')])
    const result = runTaskClose(['123', '--pr', '460', '--verification', 'run'], { ...deps, prBody: noCardLine, prCard: () => 123 })
    expect(result.exitCode).toBe(0)
    expect(written).toHaveLength(1)
    expect(result.stderr).toEqual([expect.stringContaining('warning: the body of PR #460 does not open with the card line')])
  })

  it('closes a PR with no prs row whose body opens with the card line', () => {
    const { deps, written } = world([startLine('123', 'implement')])
    const body = '#123 n [implement/ghosts/S/cheap/owner] · depends — · blocks —\n\nbody'
    expect(runTaskClose(['123', '--pr', '460', '--verification', 'run'], { ...deps, prBody: () => read(body), prCard: () => null }).exitCode).toBe(0)
    expect(written).toHaveLength(1)
  })

  it('refuses and writes nothing when the bus cannot be read', () => {
    const { deps, written } = world([startLine('123', 'implement')])
    const result = runTaskClose(['123', '--pr', '460', '--verification', 'run'], { ...deps, prCard: () => {
      throw new Error('database is locked')
    } })
    expect(result.exitCode).toBe(1)
    expect(written).toEqual([])
    expect(result.stderr).toEqual(['[task:close] the bus was not read, so whose result PR #460 is was not checked: database is locked; nothing written'])
  })

  describe('--shared-by', () => {
    const DECISIONS = '/owner-decisions.md'
    const D60 = '- D-60 · 2026-10-13 — #532 and #533 share PR #642. · card #532'
    const BODY_OF_534 = '#534 atlas-command [implement/engram/M/cheap/auto] · depends — · blocks —\n\nbody'

    it('shares the PR with the card of its prs row, not the card its body line names', () => {
      const { deps, written } = world([startLine('532', 'implement')], [], { [DECISIONS]: `# Owner decisions\n\n${D60}\n` })
      const result = runTaskClose(['532', '--pr', '642', '--shared-by', 'D-60', '--verification', 'run'], { ...deps, decisionsFile: DECISIONS, prBody: () => read(BODY_OF_534), prCard: () => 533 })
      expect(result.exitCode).toBe(0)
      expect(JSON.parse(written[0]!)).toMatchObject({ event: 'path', task: '532', pr: 642, sharedBy: 'D-60' })
    })

    it('names both the bus and the body when a PR has no prs row and no card line', () => {
      const { deps, written } = world([startLine('532', 'implement')], [], { [DECISIONS]: `# Owner decisions\n\n${D60}\n` })
      const result = runTaskClose(['532', '--pr', '642', '--shared-by', 'D-60', '--verification', 'run'], { ...deps, decisionsFile: DECISIONS, prBody: noCardLine, prCard: () => null })
      expect(result.exitCode).toBe(1)
      expect(written).toEqual([])
      expect(result.stderr).toEqual(['[task:close] --shared-by D-60: PR #642 has no prs row in the bus and its body opens with no card line, so no card shares it with #532; nothing written'])
    })
  })

  it('prCardOf reads card_id of the PR from the prs table, and null for a PR with no row or no bus', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pr-card-'))
    try {
      const file = path.join(dir, 'bus.db')
      const db = openBus(file)
      try {
        appendEvent(db, { ts: '2026-10-13T10:00:00.000Z', type: 'pr.observed', actor: 'netwatch', cardId: 855, pr: 786, head: null, dedupeKey: 'pr:786', payload: {}, legacy: false })
        db.prepare('INSERT INTO prs (pr, card_id, event_id) VALUES (?, ?, (SELECT MAX(id) FROM events))').run(786, 855)
      }
      finally {
        db.close()
      }
      expect(prCardOf(file, 786)).toBe(855)
      expect(prCardOf(file, 787)).toBeNull()
      expect(prCardOf(path.join(dir, 'absent.db'), 786)).toBeNull()
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('task:close after the cutoff records the closing in the bus', () => {
  const AFTER = new Date('2026-10-13T18:00:00.000Z')

  it('task:close after the cutoff writes card.verified and no path line', () => {
    const bus = busWithCardStarted([])
    try {
      journalInBus(bus.file, [startLine('123', 'implement')])
      const { deps, written } = world([])
      const result = runTaskClose(['123', '--pr', '460', '--verification', 'run'], { ...deps, now: () => AFTER, busPath: bus.file, session: WINDOW_SESSION })
      expect(result.exitCode).toBe(0)
      expect(written).toEqual([])
      expect(result.stdout.find(line => line.startsWith('RESULT'))).toBe(`RESULT   | closed run · PR #460 · ${CARD_VERIFIED} written to ${bus.file} · forecast not recorded on the start line · actual tokens not recorded, minutes not recorded`)
      expect(cardVerifiedClosings(bus.file)).toEqual([{ task: '123', pr: 460, verification: 'run', actual: { tokens: null, minutes: null }, event: expect.any(Number) }])
      const db = openBus(bus.file)
      try {
        const row = db.prepare(`SELECT actor, payload FROM events WHERE type = '${CARD_VERIFIED}'`).get() as { actor: string, payload: string }
        expect(row.actor).toBe(`worker:task-close:${WINDOW_SESSION}`)
        expect(JSON.parse(row.payload)).toEqual({ path: 'cheap', pr: 460, verification: 'run', ended: AFTER.toISOString(), sessions: [{ id: WINDOW_SESSION }], actual: { tokens: null, minutes: null } })
      }
      finally {
        db.close()
      }
    }
    finally {
      bus.remove()
    }
  })

  it('task:close refuses and writes nothing when card.verified cannot be written', () => {
    const bus = busWithCardStarted([])
    journalInBus(bus.file, [startLine('123', 'implement')])
    chmodSync(bus.file, 0o444)
    try {
      const { deps, written } = world([])
      const result = runTaskClose(['123', '--pr', '460', '--verification', 'run'], { ...deps, now: () => AFTER, busPath: bus.file })
      expect(result.exitCode).toBe(1)
      expect(result.stderr.join('\n')).toContain(`${CARD_VERIFIED} could not be written to the bus ${bus.file}`)
      expect(written).toEqual([])
      expect(cardVerifiedClosings(bus.file)).toEqual([])
    }
    finally {
      bus.remove()
    }
  })

  it('the closing history reads as path lines only the card.verified rows written before the cutoff', () => {
    const bus = busWithCardStarted([])
    try {
      journalInBus(bus.file, [startLine('123', 'implement')])
      const { deps } = world([])
      expect(runTaskClose(['123', '--pr', '460', '--verification', 'run'], { ...deps, now: () => AFTER, busPath: bus.file, session: WINDOW_SESSION }).exitCode).toBe(0)
      const before = '2026-10-11T09:00:00.000Z'
      const db = openBus(bus.file)
      try {
        appendEvent(db, { ts: before, type: CARD_VERIFIED, actor: 'worker:task-close:t', cardId: 124, pr: 461, head: null, dedupeKey: `${CARD_VERIFIED}:124:${before}`, payload: { path: 'cheap', pr: 461, verification: 'review' }, legacy: false })
      }
      finally {
        db.close()
      }
      expect(closingHistoryLines(bus.file)).toEqual([{ event: 'path', task: '124', path: 'cheap', pr: 461, verification: 'review', ts: before }])
      expect(closingHistoryLines(path.join(path.dirname(bus.file), 'absent.db'))).toEqual([])
    }
    finally {
      bus.remove()
    }
  })
})
