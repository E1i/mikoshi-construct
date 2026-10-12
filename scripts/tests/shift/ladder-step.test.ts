import type { Card } from '../../../src/card/grammar.js'
import type { PnpmResult } from '../../shift/shift.js'
import { execFileSync } from 'node:child_process'
import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseCard } from '../../../src/card/grammar.js'
import { approvalSha256, canonicalImplementText } from '../../ghosts/approval.js'
import { approvedSha256Of, briefPathOf, isLadder, ladderStep, tasksFilePathOf, tasksFileText } from '../../shift/ladder.js'
import { runShift } from '../../shift/shift.js'
import { captured, cardLine, eventsOf, fakeGh, newWorld } from './fixtures/autopilot-world.js'
import { approvalLine, approve, BRIEF_TEXT, briefOf, EXPECT_LINE, LADDER, ladderDeps, ladderPnpm, revokeLine } from './fixtures/ladder-world.js'

function cardOf(line: string): Card {
  const parsed = parseCard(line)
  if (parsed.kind === 'refused')
    throw new Error(parsed.reason)
  return parsed.card
}

const CARD = cardOf('#603 shift-runs-ladder [implement/runner/M/ladder/owner] · depends #602 · blocks —')
const SHA = approvalSha256(canonicalImplementText(BRIEF_TEXT)!)
const APPROVED = approvalLine(603, 'morse')
const entry = (sha = SHA, task = 'shift-runs-ladder'): object => ({ event: 'entry', task, CONTRACT: `ladder · brief b.md approved ${sha.slice(0, 7)} · law brief Acceptance:` })
const ended = (ladder: string, sha = SHA): object => ({ event: 'task', task: 'shift-runs-ladder', approvedSha256: sha, ladder })
const journal = (...lines: object[]): string => `${APPROVED}${lines.map(line => JSON.stringify(line)).join('\n')}\nnot json\n`
const step = (text: string | null, brief: string | null = BRIEF_TEXT): string => ladderStep({ journal: text, brief }, CARD).kind

describe('the ladder step is derived from the journal and the brief', () => {
  it('is brief while there is no brief, no approval event, or an approval of another text', () => {
    expect(step(null, null)).toBe('brief')
    expect(step(null, BRIEF_TEXT)).toBe('brief')
    expect(step(APPROVED, `${BRIEF_TEXT}changed\n`)).toBe('brief')
    expect(step(approvalLine(603, 'morse', '0'.repeat(64)))).toBe('brief')
    expect(step(approvalLine(604, 'morse'))).toBe('brief')
  })

  it('is launch once the current text is approved and no entry names that hash', () => {
    expect(ladderStep({ journal: APPROVED, brief: BRIEF_TEXT }, CARD)).toEqual({ kind: 'launch', sha256: SHA })
    expect(step(journal(entry('0'.repeat(64)), entry(SHA, 'another-task')))).toBe('launch')
  })

  it('is running while an entry has no Ghost task line after it', () => {
    expect(step(journal(entry()))).toBe('running')
    expect(step(journal(ended('done'), entry()))).toBe('running')
    expect(step(journal(entry(), ended('done', '0'.repeat(64))))).toBe('running')
  })

  it('is review when the Ghost task line after the entry says ladder done', () => {
    expect(step(journal(entry(), ended('done')))).toBe('review')
  })

  it('is a fault naming any other ladder status', () => {
    expect(ladderStep({ journal: journal(entry(), ended('stopped')), brief: BRIEF_TEXT }, CARD)).toEqual({ kind: 'fault', why: `the Ghost ended with ladder status 'stopped'` })
  })

  it('is running again when a newer entry follows a finished Ghost', () => {
    expect(step(journal(entry(), ended('done'), entry()))).toBe('running')
  })

  it('a newly approved text is launch even when an older text was launched', () => {
    const olderSha = approvalSha256(canonicalImplementText(`${BRIEF_TEXT}older\n`)!)
    const older = `${approvalLine(603, 'morse', olderSha)}${JSON.stringify(entry(olderSha))}\n`
    expect(ladderStep({ journal: `${older}${APPROVED}`, brief: BRIEF_TEXT }, CARD)).toEqual({ kind: 'launch', sha256: SHA })
  })
})

describe('the ladder files of a card', () => {
  it('names the brief and the tasks file after the card number and name', () => {
    expect(briefPathOf('/h', CARD)).toBe('/h/brief-603-shift-runs-ladder.md')
    expect(tasksFilePathOf('/h', CARD)).toBe('/h/tasks-603-shift-runs-ladder.json')
  })

  it('writes the tasks file ghosts:launch reads: the card name is the task id', () => {
    expect(JSON.parse(tasksFileText(CARD, { repo: '/r', handoffDir: '/h', brief: '/h/b.md' }))).toEqual({ repo: '/r', status: '/h/status.md', out: '/h', tasks: [{ id: 'shift-runs-ladder', brief: '/h/b.md', card: CARD.line }] })
  })

  it('marks a ladder card by kind and contour, and a probe or a cheap card is not one', () => {
    expect([CARD, cardOf('#1 a [probe/runner/S/ladder/none] · depends — · blocks —'), cardOf('#2 b [implement/runner/S/cheap/auto] · depends — · blocks —')].map(isLadder)).toEqual([true, false, false])
  })
})

describe('the approved hash of a card is read from the journal alone', () => {
  it('is the current hash when an approval event names it and no revoke does', () => {
    expect(approvedSha256Of({ journal: APPROVED, brief: BRIEF_TEXT }, CARD)).toBe(SHA)
    expect(approvedSha256Of({ journal: `${APPROVED}${revokeLine(603)}`, brief: BRIEF_TEXT }, CARD)).toBeNull()
    expect(approvedSha256Of({ journal: null, brief: BRIEF_TEXT }, CARD)).toBeNull()
  })

  it('is brief after a revoke of that hash, and launch for an approval by the owner as much as by MORSE', () => {
    expect(step(`${APPROVED}${revokeLine(603)}`)).toBe('brief')
    expect(step(approvalLine(603, 'owner'))).toBe('launch')
  })
})

const BRANCH_SKETCH = `Sketch: sketch/task-1 @ ${'a'.repeat(40)}`
const NO_EXPECT = '/implement stub brief\nSketch: none — stub\n'

interface Session { written: string, dirty?: boolean, sample?: PnpmResult, hook?: string, staleBranch?: boolean }

interface AfterSession { brief: string, sampled: string[][], hashed: number, branches: string, head: string, tip: string, status: string, stops: Record<string, unknown>[] }

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
}

function branchTip(repo: string, branch: string): string {
  try {
    return git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).trim()
  }
  catch {
    return ''
  }
}

async function briefAfterSession(session: Session): Promise<AfterSession> {
  const world = newWorld([{ id: 1, kind: LADDER, who: 'shift', body: 'do 1 STUB-BRIEF-WRITE' }])
  const text = path.join(world.stubOut, 'written-brief.md')
  const script = path.join(world.stubOut, 'writing.sh')
  const stub = path.join(import.meta.dirname, 'fixtures', 'claude-stub-ladder.sh')
  writeFileSync(text, session.written)
  writeFileSync(script, `prompt=$(cat)\nprintf '%s\\n' "$prompt" | sh ${stub} "$@" || exit $?\ncp ${text} ${briefOf(world, 1)}\n${session.dirty === true ? 'printf \'sketch\\n\' > sketch.txt\n' : ''}`)
  if (session.hook !== undefined) {
    const hook = path.join(world.repo, '.git', 'hooks', 'pre-commit')
    writeFileSync(hook, `#!/bin/sh\necho '${session.hook}' >&2\nexit 1\n`)
    chmodSync(hook, 0o755)
  }
  if (session.staleBranch === true)
    git(world.repo, ['branch', 'sketch/task-1'])
  const sampled: string[][] = []
  const base = ladderPnpm(world, 1, { morse: 'refuses' })
  const pnpm = (cwd: string, args: string[], input?: string): PnpmResult => {
    if (args[0] !== 'ghosts:expect-sample')
      return base.pnpm(cwd, args, input)
    sampled.push(args)
    return session.sample ?? { code: 0, stdout: `${EXPECT_LINE}\n`, stderr: '' }
  }
  const { gh } = fakeGh({ 101: cardLine(1, LADDER) })
  const claude = `STUB_OUT=${world.stubOut} CONSTRUCT_HANDOFF_DIR=${world.handoff} sh ${script}`
  await runShift([world.shift, '--parking', world.parking], ladderDeps(world, gh, captured(), { calls: base.calls, pnpm }, { claude }))
  const tree = path.join(world.root, 'mc-1')
  return {
    brief: readFileSync(briefOf(world, 1), 'utf8'),
    sampled,
    hashed: base.calls.filter(call => call.args[0] === 'ghosts:hash').length,
    branches: git(world.repo, ['branch', '--list', 'sketch/*']),
    head: git(tree, ['rev-parse', '--abbrev-ref', 'HEAD']).trim(),
    tip: branchTip(world.repo, 'sketch/task-1'),
    status: git(tree, ['status', '--porcelain']),
    stops: eventsOf(world, 'stop'),
  }
}

describe('the shift finishes a brief its session could not', () => {
  it('a brief that already has an expect: line keeps it unsampled, and its dirty tree is still committed to a sketch branch', async () => {
    const after = await briefAfterSession({ written: `${NO_EXPECT}${EXPECT_LINE}\n`, dirty: true })
    expect(after.brief).toMatch(new RegExp(`^/implement stub brief\nSketch: sketch/task-1 @ [0-9a-f]{40}\n${EXPECT_LINE}\n$`))
    expect(after.sampled).toEqual([])
    expect(after.branches).toBe('  sketch/task-1\n')
    expect(after.head).toBe('feat/1')
    expect(after.status).toBe('')
  })

  it('a brief with an expect: line on a clean tree is left exactly as written', async () => {
    const written = `${NO_EXPECT}${EXPECT_LINE}\n`
    const after = await briefAfterSession({ written })
    expect(after.brief).toBe(written)
    expect(after.sampled).toEqual([])
    expect(after.branches).toBe('')
  })

  it('a rerun commits its sketch over a sketch branch an earlier run left behind', async () => {
    const after = await briefAfterSession({ written: NO_EXPECT, dirty: true, staleBranch: true })
    const sha = /^Sketch: sketch\/task-1 @ ([0-9a-f]{40})$/m.exec(after.brief)?.[1]
    expect(sha).toBeDefined()
    expect(after.tip).toBe(sha)
    expect(after.head).toBe('feat/1')
    expect(after.status).toBe('')
  })

  it('a brief that already names a branch sketch keeps its Sketch line and makes no sketch branch', async () => {
    const after = await briefAfterSession({ written: `/implement stub brief\n${BRANCH_SKETCH}\n` })
    expect(after.brief).toBe(`/implement stub brief\n${BRANCH_SKETCH}\n${EXPECT_LINE}\n`)
    expect(after.sampled).toEqual([['ghosts:expect-sample', '--sketch', 'yes']])
    expect(after.branches).toBe('')
  })

  it('a sketch the shift just committed is sampled with --sketch yes and the brief\'s Effort: line in lower case', async () => {
    const after = await briefAfterSession({ written: `${NO_EXPECT}Effort: Medium\n`, dirty: true })
    expect(after.sampled).toEqual([['ghosts:expect-sample', '--effort', 'medium', '--sketch', 'yes']])
    expect(after.brief).toMatch(new RegExp(`^/implement stub brief\nSketch: sketch/task-1 @ [0-9a-f]{40}\n${EXPECT_LINE}\nEffort: Medium\n$`))
  })

  it('a failing ghosts:expect-sample stops at hash with its first line, before MORSE, and the committed sketch stays named', async () => {
    const after = await briefAfterSession({ written: NO_EXPECT, dirty: true, sample: { code: 1, stdout: `${EXPECT_LINE}\n`, stderr: 'no runs to sample\nsecond line\n' } })
    expect(after.stops).toMatchObject([{ task: '1', at: 'hash' }])
    expect(String(after.stops[0]?.why)).toContain('no runs to sample')
    expect(String(after.stops[0]?.why)).not.toContain('second line')
    expect(after.sampled).toEqual([['ghosts:expect-sample', '--sketch', 'yes']])
    expect(after.hashed).toBe(0)
    expect(after.brief).toMatch(/^\/implement stub brief\nSketch: sketch\/task-1 @ [0-9a-f]{40}\n$/)
    expect(after.head).toBe('feat/1')
    expect(after.status).toBe('')
  })

  it('a failing sketch commit stops at hash and returns the tree to its branch with the sketch unstaged and no sketch branch left', async () => {
    const after = await briefAfterSession({ written: NO_EXPECT, dirty: true, hook: 'hook refuses the sketch' })
    expect(after.stops).toMatchObject([{ task: '1', at: 'hash' }])
    expect(String(after.stops[0]?.why)).toMatch(/: hook refuses the sketch$/)
    expect(after.hashed).toBe(0)
    expect(after.sampled).toEqual([])
    expect(after.brief).toBe(NO_EXPECT)
    expect(after.head).toBe('feat/1')
    expect(after.status).toBe('?? sketch.txt\n')
    expect(after.branches).toBe('')
  })
})

describe('a failed ladder launch keeps what it printed', () => {
  it('a failed ladder launch writes its stderr tail and log path into its fault line', async () => {
    const world = newWorld([{ id: 1, kind: LADDER, who: 'shift', body: 'do 1 STUB-BRIEF-WRITE STUB-VERIFIED-run STUB-PR-101' }])
    const { gh } = fakeGh({ 101: cardLine(1, LADDER) })
    await runShift([world.shift, '--parking', world.parking], ladderDeps(world, gh, captured(), ladderPnpm(world, 1, { morse: 'refuses' })))
    approve(world, 1)
    const shift = path.join(world.root, 'shift-2')
    const lines = Array.from({ length: 25 }, (_, index) => `launch line ${index}`)
    const refused = ladderPnpm(world, 1, { launch: 'exit' })
    const launch = { calls: refused.calls, pnpm: (cwd: string, args: string[], input?: string) => args[0] === 'ghosts:launch' ? { ...refused.pnpm(cwd, args, input), stdout: 'preflight: base abc1234\n', stderr: `${lines.join('\n')}\n` } : refused.pnpm(cwd, args, input) }
    await runShift([shift, '--parking', world.parking], ladderDeps(world, gh, captured(), launch))

    const log = path.join(shift, '1-launch.log')
    expect(eventsOf(world, 'stop').at(-1)).toMatchObject({ task: '1', at: 'fault', why: 'launch line 0', tail: lines.slice(-20).join('\n'), log })
    expect(readFileSync(log, 'utf8')).toBe(`preflight: base abc1234\n${lines.join('\n')}\n`)
  })
})
