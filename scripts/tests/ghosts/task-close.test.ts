import type { TaskCloseDeps } from '../../ghosts/task-close.js'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { VERIFICATION_WORDS } from '../../board/verification.js'
import { runTaskClose } from '../../ghosts/task-close.js'

const LAUNCH_SESSION = 'ghost-session'

const HANDOFF = '/handoff'
const JOURNAL = path.join(HANDOFF, 'ghosts.jsonl')
const NOW = new Date('2026-10-03T09:00:00.000Z')
const PROJECTS = '/projects'
const WINDOW_SESSION = 'window-session'

function startLine(id: string, kind: 'implement' | 'probe', session?: string): string {
  const decision = kind === 'probe' ? 'none' : 'owner'
  return JSON.stringify({ event: 'path', task: id, path: 'cheap', started: 'x', ...(session === undefined ? {} : { session }), worktree: `/mc-${id}`, branch: `feat/${id}`, card: { id: Number(id), name: 'n', kind, milestone: 'ghosts', size: 'S', contour: 'cheap', decision, depends: [], blocks: [], line: 'l' }, ts: 'x' })
}

function world(journal: string[], sessionFiles: string[] = [], files: Record<string, string> = {}): { deps: TaskCloseDeps, written: string[] } {
  const written: string[] = []
  return {
    written,
    deps: {
      cwd: '/work',
      read: file => file === JOURNAL ? `${journal.join('\n')}\n` : files[file] ?? null,
      append: (file, text) => {
        expect(file).toBe(JOURNAL)
        written.push(text)
      },
      now: () => NOW,
      handoffDir: HANDOFF,
      exists: file => sessionFiles.includes(file),
      session: undefined,
      projectsDir: PROJECTS,
      tokens: () => null,
    },
  }
}

function sessionFile(key: string, id: string): string {
  return path.join(PROJECTS, key, `${id}.jsonl`)
}

describe('w3: task:close writes the closing line the board reads', () => {
  it('w3: an implement task closes with its PR and the verification word', () => {
    const { deps, written } = world([startLine('123', 'implement')])
    const result = runTaskClose(['123', '--pr', '460', '--verification', 'run'], deps)
    expect(result.exitCode).toBe(0)
    expect(written.map(text => JSON.parse(text) as unknown)).toEqual([{ event: 'path', task: '123', path: 'cheap', pr: 460, verification: 'run', ended: NOW.toISOString(), sessions: [], actual: { tokens: null, minutes: null }, ts: NOW.toISOString() }])
  })

  it('w3: a probe closes with its report, resolved against the working directory', () => {
    const { deps, written } = world([startLine('7', 'probe')])
    expect(runTaskClose(['7', '--report', 'probe-7.md', '--verification', 'measurement'], deps).exitCode).toBe(0)
    expect(JSON.parse(written[0]!)).toMatchObject({ task: '7', report: '/work/probe-7.md', verification: 'measurement' })
    expect(JSON.parse(written[0]!)).not.toHaveProperty('pr')
  })

  it('w3: reads the last start line with a card for the id, past unreadable lines and lines without a card', () => {
    const { deps, written } = world(['{not json', JSON.stringify({ event: 'path', task: '9', path: 'cheap', ts: 'x' }), startLine('9', 'probe')])
    expect(runTaskClose(['9', '--report', '/r.md', '--verification', 'review'], deps).exitCode).toBe(0)
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
      `RESULT   | closed run · PR #460 · line written to ${JOURNAL}`,
    ])
  })

  it('names the contract and the forecast as not recorded when no entry line holds them', () => {
    const { deps } = world([startLine('123', 'implement')])
    const result = runTaskClose(['123', '--pr', '460', '--verification', 'run'], deps)
    expect(result.stdout[1]).toBe(`CONTRACT | contract not recorded in ${JOURNAL}: no entry line for #123`)
    expect(result.stdout[2]).toBe(`EXPECT   | expect not recorded in ${JOURNAL}: no entry line for #123`)
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
    expect(runTaskClose(['160', '--pr', '518', '--verification', 'run'], deps).stderr[0]).toContain('has no task:start line with a card for #160')
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
    expect(result.stderr).toEqual([`[task:close] --verification mutation needs a mutation-judged line for #123 in ${JOURNAL}, and there is none; nothing written`])
    expect(written).toEqual([])
  })

  it('refuses mutation on a nothing-red line, even when its prediction matched', () => {
    const { deps, written } = world([startLine('123', 'implement'), judgedLine('123', 'M1', 'named-red', true), judgedLine('123', 'M2', 'nothing-red', true), judgedLine('123', 'M3', 'other-red', false)])
    const result = runTaskClose(['123', '--pr', '460', '--verification', 'mutation'], deps)
    expect(result.stderr).toEqual([`[task:close] --verification mutation refused: M2 of #123 survived (outcome nothing-red) in ${JOURNAL}; nothing written`])
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
    expect(result.stderr).toEqual([`[task:close] --verification mutation refused: M4b of #665 survived (outcome nothing-red) in ${JOURNAL}; nothing written`])
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
    ['no start line with a card', ['55', '--pr', '460', '--verification', 'run'], 'has no task:start line with a card for #55'],
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

  it('refuses when the journal does not exist', () => {
    const { deps } = world([])
    expect(runTaskClose(['1', '--pr', '2', '--verification', 'run'], { ...deps, read: () => null }).exitCode).toBe(1)
  })
})

describe('a cloud run closes on its cloud-start line', () => {
  it('task:close closes a task whose only start line is a cloud-start line', () => {
    const line = '#665 probe-card [probe/ghosts/S/cheap/none] · depends — · blocks —'
    const card = { id: 665, name: 'probe-card', kind: 'probe', milestone: 'ghosts', size: 'S', contour: 'cheap', decision: 'none', depends: [], blocks: [], line }
    const journal = [
      JSON.stringify({ event: 'intake', task: '665', card: line, confirmation: 'none', corrections: [], ts: 'x' }),
      JSON.stringify({ event: 'cloud-start', task: '665', card, run: 'trig_1', base: null, ts: 'x' }),
    ]
    const { deps, written } = world(journal)
    const result = runTaskClose(['665', '--report', '/r.md', '--verification', 'run'], deps)
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(written[0]!)).toMatchObject({ event: 'path', task: '665', path: 'cheap', report: '/r.md', verification: 'run', sessions: [{ id: 'trig_1' }] })
  })
})

describe('the card line of the pull request body', () => {
  const prBodyOf = (body: string | null) => (): string | null => body

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

  it('notes a body that cannot be read and still closes', () => {
    const { deps, written } = world([startLine('123', 'implement')])
    const result = runTaskClose(['123', '--pr', '460', '--verification', 'run'], { ...deps, prBody: () => {
      throw new Error('gh: no network')
    } })
    expect(result.exitCode).toBe(0)
    expect(written).toHaveLength(1)
    expect(result.stderr).toEqual([expect.stringContaining('body not read, card line not checked: gh: no network')])
  })
})
