import type { TaskCloseDeps } from '../../ghosts/task-close.js'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { VERIFICATION_WORDS } from '../../board/verification.js'
import { runTaskClose } from '../../ghosts/task-close.js'

const HANDOFF = '/handoff'
const JOURNAL = path.join(HANDOFF, 'ghosts.jsonl')
const NOW = new Date('2026-10-03T09:00:00.000Z')
const PROJECTS = '/projects'
const WINDOW_SESSION = 'window-session'

function startLine(id: string, kind: 'implement' | 'probe', session?: string): string {
  const decision = kind === 'probe' ? 'none' : 'owner'
  return JSON.stringify({ event: 'path', task: id, path: 'cheap', started: 'x', ...(session === undefined ? {} : { session }), worktree: `/mc-${id}`, branch: `feat/${id}`, card: { id: Number(id), name: 'n', kind, milestone: 'ghosts', size: 'S', contour: 'cheap', decision, depends: [], blocks: [], line: 'l' }, ts: 'x' })
}

function world(journal: string[], sessionFiles: string[] = []): { deps: TaskCloseDeps, written: string[] } {
  const written: string[] = []
  return {
    written,
    deps: {
      cwd: '/work',
      read: file => file === JOURNAL ? `${journal.join('\n')}\n` : null,
      append: (file, text) => {
        expect(file).toBe(JOURNAL)
        written.push(text)
      },
      now: () => NOW,
      handoffDir: HANDOFF,
      exists: file => sessionFiles.includes(file),
      session: undefined,
      projectsDir: PROJECTS,
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
    expect(written.map(text => JSON.parse(text) as unknown)).toEqual([{ event: 'path', task: '123', path: 'cheap', pr: 460, verification: 'run', ended: NOW.toISOString(), sessions: [], ts: NOW.toISOString() }])
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

describe('task:close records when the task ended and the sessions it used, each with the project key its file lies under', () => {
  it('records the window session under the key of the directory the window runs in, not the task worktree', () => {
    const { deps, written } = world([startLine('5', 'implement', WINDOW_SESSION)], [sessionFile('-work', WINDOW_SESSION)])
    const result = runTaskClose(['5', '--pr', '9', '--verification', 'run'], deps)
    expect(JSON.parse(written[0]!)).toMatchObject({ ended: NOW.toISOString(), sessions: [{ id: WINDOW_SESSION, project: '-work' }] })
    expect(result.stdout).toHaveLength(1)
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
    expect(result.stdout[1]).toBe(`[task:close] #5 session ${WINDOW_SESSION} project not recorded: no session file under -work or -mc-5 in ${PROJECTS}`)
  })

  it('names the sessions as not recorded when neither the start line nor the closing window carries one', () => {
    const { deps } = world([startLine('5', 'implement')])
    expect(runTaskClose(['5', '--pr', '9', '--verification', 'run'], deps).stdout[1]).toBe('[task:close] #5 sessions not recorded on the start line or in CLAUDE_CODE_SESSION_ID')
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
