import type { AnswererTools, AnswerRequest } from '../../nodes/answer/answerer.js'
import type { AnswerRun } from '../../nodes/answer/duties/index.js'
import type { CardTreeTools } from '../../ports/card-tree.js'
import type { MergeBench } from './merge-bench.js'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { appendEvent } from '../../core/db.js'
import { ANSWER_STEP, CARD_STARTED, CARD_STOPPED, QUESTION_AGENT } from '../../core/events.js'
import { leaseNext } from '../../core/lease.js'
import { queueTask } from '../../core/queue.js'
import { AnswerExecutor } from '../../nodes/answer/answer-executor.js'
import { claudeAnswerer, FreshBaseConflict, ownerQuestionPath, realAnswererTools, RoundTimer } from '../../nodes/answer/answerer.js'
import { TSX_PIPE_DIRECTORY } from '../../ports/shift-settings.js'
import { sha } from './github-fake.js'
import { eventsOf, mergeBench } from './merge-bench.js'

const CARD_SESSION = 'card-session-1207'
const NEW_SESSION = 'new-session-1'
const CONTEXT_WARN = 200_000
const CARD_BODY = '#1207 answer-starts-fresh [implement/netwatch/S/cheap/owner]\n\nthe card body'
const DIFF = 'diff --git a/scripts/bus/answerer.ts b/scripts/bus/answerer.ts\n+the change so far'
const FINDING = 'the retry is missing'
const TREE_GATE = 'pnpm run gate-of-the-tree'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function requestIn(root: string): AnswerRequest {
  const worktree = path.join(root, 'mc-1207')
  mkdirSync(worktree, { recursive: true })
  writeFileSync(path.join(worktree, 'construct.json'), `${JSON.stringify({ harness: { command: 'pnpm run quality' }, shift: { prepush: [TREE_GATE] } })}\n`)
  return {
    lease: { taskKey: 'answer:1207:1300', queue: 'answer', cardId: 1207, pr: 1300, head: 'a'.repeat(40), leaseGen: 1, actor: 'worker:answer:worker-1' },
    source: { kind: 'changes', findings: [FINDING], events: [], decisions: [] },
    widened: null,
    card: { session: CARD_SESSION, worktree, branch: 'feat/card-1207' },
  }
}

function settingsOf(run: AnswerRun): unknown {
  const at = run.argv.indexOf('--settings')
  return at === -1 ? null : JSON.parse(run.argv[at + 1]!)
}

function treeSettings(worktree: string, ownerQuestion: string): unknown {
  return {
    sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, network: { allowLocalBinding: true, allowUnixSockets: [TSX_PIPE_DIRECTORY] } },
    permissions: { allow: [`Bash(${TREE_GATE})`, `Edit(/${worktree}/**)`, `Edit(/${ownerQuestion})`] },
    autoMemoryEnabled: false,
    claudeMdExcludes: [path.join(homedir(), '.claude', 'CLAUDE.md')],
  }
}

async function answerAt(context: number, cardTools?: AnswererTools['cardTools']) {
  const root = mkdtempSync(path.join(tmpdir(), 'bus-answerer-'))
  roots.push(root)
  const runs: AnswerRun[] = []
  const published: string[] = []
  const heads = ['a'.repeat(40), 'e'.repeat(40)]
  const request = requestIn(root)
  const answerer = claudeAnswerer(path.join(root, 'answers'), {
    cardText: () => CARD_BODY,
    ...(cardTools === undefined ? {} : { cardTools }),
    available: () => true,
    remoteHead: () => heads.shift() ?? null,
    spawn: async (run) => {
      runs.push(run)
      writeFileSync(run.stdoutPath, `${JSON.stringify({ type: 'result', subtype: 'success', result: 'answered' })}\n`)
      return 0
    },
    newSession: () => NEW_SESSION,
    publish: card => published.push(card.branch),
    context: session => (session === CARD_SESSION ? context : 30_000),
    contextWarn: () => CONTEXT_WARN,
    diff: () => DIFF,
  })
  const answered = await answerer(request)
  return { answered, runs, published, prompt: runs[0]!.argv.at(-1)! }
}

describe('the answerer', () => {
  it('starts a new session in the card tree when the card session context is above warn', async () => {
    const { answered, runs, published, prompt } = await answerAt(201_662)

    expect(answered).toMatchObject({ session: NEW_SESSION, resumed: false, after: 'e'.repeat(40) })
    expect(runs).toHaveLength(1)
    expect(runs[0]!.argv).not.toContain('--resume')
    expect(runs[0]!.argv).toContain(NEW_SESSION)
    expect(runs[0]!.cwd).toMatch(/mc-1207$/)
    expect(prompt).toContain(CARD_BODY)
    expect(prompt).toContain(FINDING)
    expect(prompt).toContain(DIFF)
    expect(published).toEqual(['feat/card-1207'])
  })

  it('starts a new session when the card session context is exactly at warn', async () => {
    const { answered } = await answerAt(CONTEXT_WARN)

    expect(answered).toMatchObject({ session: NEW_SESSION, resumed: false })
  })

  it('resumes the card session when its context is below warn', async () => {
    const { answered, runs, prompt } = await answerAt(120_000)

    expect(answered).toMatchObject({ session: CARD_SESSION, resumed: true, atContextWarn: false })
    expect(runs[0]!.argv).toEqual(expect.arrayContaining(['--resume', CARD_SESSION]))
    expect(prompt).not.toContain(DIFF)
  })

  it.each([[201_662, 'new'], [120_000, 'resumed']])('starts the %s-context %s session with the shift settings of the card tree and its owner-question file', async (context) => {
    const { answered, runs } = await answerAt(context)
    const worktree = runs[0]!.cwd
    const ownerQuestion = ownerQuestionPath(path.join(path.dirname(worktree), 'answers'), answered.session, 1)

    expect(runs.map(settingsOf)).toEqual([treeSettings(worktree, ownerQuestion)])
  })

  it('hands the card body to cardTools and widens the session by the words it returns', async () => {
    const bodies: (string | null)[] = []
    const { runs } = await answerAt(120_000, (_cardId, cardBody) => {
      bodies.push(cardBody)
      return ['web']
    })

    expect(bodies).toEqual([CARD_BODY])
    expect(runs[0]!.argv).toEqual(expect.arrayContaining(['--tools', 'Read,Edit,Write,Bash,Grep,Glob,WebFetch,WebSearch']))
  })
})

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function committer(repo: string): void {
  git(repo, ['config', 'user.email', 'answer@example.com'])
  git(repo, ['config', 'user.name', 'answer'])
  git(repo, ['config', 'commit.gpgsign', 'false'])
}

describe('the answer path publishes on a fresh base', () => {
  it('the answer path merges main before a push as launch does', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bus-answerer-'))
    roots.push(root)
    const origin = path.join(root, 'origin.git')
    const worktree = path.join(root, 'mc-1207')
    const upstream = path.join(root, 'upstream')
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin])
    execFileSync('git', ['init', '-q', '-b', 'main', worktree])
    committer(worktree)
    writeFileSync(path.join(worktree, 'a.md'), 'base\n')
    git(worktree, ['add', '-A'])
    git(worktree, ['commit', '-q', '-m', 'base'])
    git(worktree, ['remote', 'add', 'origin', origin])
    git(worktree, ['push', '-q', 'origin', 'main'])
    git(worktree, ['checkout', '-q', '-b', 'feat/card-1207'])
    execFileSync('git', ['clone', '-q', origin, upstream])
    committer(upstream)
    writeFileSync(path.join(upstream, 'b.md'), 'main moved\n')
    git(upstream, ['add', '-A'])
    git(upstream, ['commit', '-q', '-m', 'main moved'])
    git(upstream, ['push', '-q', 'origin', 'main'])
    writeFileSync(path.join(worktree, 'a.md'), 'the answer\n')

    realAnswererTools(path.join(root, 'bus.db')).publish({ session: CARD_SESSION, worktree, branch: 'feat/card-1207' }, 'answer for #1207')

    const fresh = git(upstream, ['rev-parse', 'main']).trim()
    expect({ onFreshBase: git(worktree, ['merge-base', fresh, 'origin/feat/card-1207']).trim() === fresh, merges: git(worktree, ['rev-list', '--merges', '--count', `${fresh}..origin/feat/card-1207`]).trim() }).toEqual({ onFreshBase: true, merges: '1' })
  })

  it('the answer path takes an owner path from main and leaves only the card file in the merge it hands over', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bus-answerer-'))
    roots.push(root)
    const origin = path.join(root, 'origin.git')
    const worktree = path.join(root, 'mc-1207')
    const upstream = path.join(root, 'upstream')
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin])
    execFileSync('git', ['init', '-q', '-b', 'main', worktree])
    committer(worktree)
    writeFileSync(path.join(worktree, 'a.md'), 'base\n')
    git(worktree, ['add', '-A'])
    git(worktree, ['commit', '-q', '-m', 'base'])
    git(worktree, ['remote', 'add', 'origin', origin])
    git(worktree, ['push', '-q', 'origin', 'main'])
    git(worktree, ['checkout', '-q', '-b', 'feat/card-1207'])
    execFileSync('git', ['clone', '-q', origin, upstream])
    committer(upstream)
    mkdirSync(path.join(upstream, 'architecture'))
    mkdirSync(path.join(upstream, '.claude'))
    writeFileSync(path.join(upstream, 'architecture/owner-merges.md'), readFileSync('architecture/owner-merges.md', 'utf8'))
    writeFileSync(path.join(upstream, '.claude/guard.mjs'), 'hook on main\n')
    writeFileSync(path.join(upstream, 'a.md'), 'main moved\n')
    git(upstream, ['add', '-A'])
    git(upstream, ['commit', '-q', '-m', 'main moved'])
    git(upstream, ['push', '-q', 'origin', 'main'])
    writeFileSync(path.join(worktree, 'a.md'), 'the answer\n')

    const publish = (): unknown => {
      try {
        realAnswererTools(path.join(root, 'bus.db')).publish({ session: CARD_SESSION, worktree, branch: 'feat/card-1207' }, 'answer for #1207')
        return null
      }
      catch (error) {
        return error instanceof FreshBaseConflict ? error.gap : error
      }
    }

    expect({ gap: publish(), hook: readFileSync(path.join(worktree, '.claude/guard.mjs'), 'utf8'), mergeInProgress: existsSync(git(worktree, ['rev-parse', '--path-format=absolute', '--git-path', 'MERGE_HEAD']).trim()) }).toEqual({ gap: { kind: 'conflict', files: ['a.md'], failure: null }, hook: 'hook on main\n', mergeInProgress: true })
  })

  it('a conflict on the fresh base resumes the session to merge, then publishes; one it leaves is a question', async () => {
    const outcomes = await Promise.all([[], ['a.md']].map(async (left) => {
      const root = mkdtempSync(path.join(tmpdir(), 'bus-answerer-'))
      roots.push(root)
      const runs: AnswerRun[] = []
      const conflicts = [['a.md'], left]
      const answerer = claudeAnswerer(path.join(root, 'answers'), {
        cardText: () => CARD_BODY,
        available: () => true,
        remoteHead: () => 'a'.repeat(40),
        spawn: async (run) => {
          runs.push(run)
          writeFileSync(run.stdoutPath, `${JSON.stringify({ type: 'result', subtype: 'success', result: 'answered' })}\n`)
          return 0
        },
        newSession: () => NEW_SESSION,
        publish: () => {
          const files = conflicts.shift() ?? []
          if (files.length > 0)
            throw new FreshBaseConflict({ files, failure: null })
        },
        context: () => 30_000,
        contextWarn: () => CONTEXT_WARN,
      })
      const answered = await answerer(requestIn(root))
      const settings = treeSettings(path.join(root, 'mc-1207'), ownerQuestionPath(path.join(root, 'answers'), answered.session, 1))
      return { owner: answered.owner, runs: runs.length, merge: runs[1]?.argv.at(-1)?.includes('resolve every conflict in a.md'), settings: runs.map(run => isDeepStrictEqual(settingsOf(run), settings)) }
    }))

    expect(outcomes).toEqual([
      { owner: null, runs: 2, merge: true, settings: [true, true] },
      { owner: 'merging a fresh origin/main into feat/card-1207 conflicts in a.md and the answer session did not resolve it', runs: 2, merge: true, settings: [true, true] },
    ])
  })

  it('the merge session after a conflict counts its tokens and its owner question stops the push', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'bus-answerer-'))
    roots.push(root)
    const dir = path.join(root, 'answers')
    const usage = [{ input_tokens: 100, output_tokens: 20 }, { input_tokens: 7, output_tokens: 3 }]
    const question = 'origin/main rewrote the gate this card changes; keep which?'
    const published: number[] = []
    const answerer = claudeAnswerer(dir, {
      cardText: () => CARD_BODY,
      available: () => true,
      remoteHead: () => 'a'.repeat(40),
      spawn: async (run) => {
        writeFileSync(run.stdoutPath, `${JSON.stringify({ type: 'result', subtype: 'success', result: 'answered', usage: usage.shift() })}\n`)
        if (run.stdoutPath.includes('.merge.'))
          writeFileSync(ownerQuestionPath(dir, CARD_SESSION, 1), `${question}\n`)
        return 0
      },
      newSession: () => NEW_SESSION,
      publish: () => {
        published.push(published.length)
        throw new FreshBaseConflict({ files: [], failure: 'untracked working tree files would be overwritten by merge: b.md' })
      },
      context: () => 30_000,
      contextWarn: () => CONTEXT_WARN,
    })

    const answered = await answerer(requestIn(root))

    expect({ owner: answered.owner, tokens: answered.tokens, publishes: published.length }).toEqual({ owner: question, tokens: 130, publishes: 1 })
  })
})

describe('the steps of an answer round on the bus', () => {
  const benches: MergeBench[] = []
  const SESSION_THAT_REACHED_THE_GATE = [
    { step: 'lease', seconds: 2 },
    { step: 'tree', seconds: 48 },
    { step: 'spawn', seconds: 4 },
    { step: 'first_turn', seconds: 11 },
    { step: 'gate', seconds: 25 },
    { step: 'push', seconds: null },
  ]

  afterEach(() => {
    vi.restoreAllMocks()
    for (const made of benches.splice(0))
      made.close()
  })

  function round(ending: (dir: string, leaseGen: number) => number) {
    const made = mergeBench()
    benches.push(made)
    const trees = mkdtempSync(path.join(tmpdir(), 'bus-answerer-'))
    roots.push(trees)
    const worktree = path.join(trees, 'mc-905')
    mkdirSync(worktree)
    writeFileSync(path.join(worktree, 'pnpm-lock.yaml'), '')
    writeFileSync(path.join(worktree, 'construct.json'), `${JSON.stringify({ harness: { command: 'pnpm run quality' }, shift: { prepush: [TREE_GATE] } })}\n`)
    const ts = made.clock.now().toISOString()
    appendEvent(made.db, { ts, type: CARD_STARTED, actor: 'worker:launch:launch-1', cardId: 905, pr: null, head: null, dedupeKey: `${CARD_STARTED}:905`, payload: { session: CARD_SESSION, worktree, branch: 'feat/card-905', base: sha('1') }, legacy: false })
    appendEvent(made.db, { ts, type: CARD_STOPPED, actor: 'worker:launch:launch-1', cardId: 905, pr: null, head: null, dedupeKey: `${CARD_STOPPED}:905`, payload: { reason: QUESTION_AGENT, detail: 'a question on card #905' }, legacy: false })
    const stop = Number((made.db.prepare(`SELECT max(id) AS id FROM events WHERE type = '${CARD_STOPPED}'`).get() as { id: number }).id)
    queueTask(made.db, ts, { queue: 'answer', cardId: 905, stop })
    const lease = leaseNext(made.db, ts, 'answer', 'worker:answer:worker-1')!
    const seconds = (count: number): void => made.clock.advance(count * 1_000)
    const dir = path.join(trees, 'answers')
    const answerer = claudeAnswerer(dir, {
      cardText: () => null,
      available: () => true,
      remoteHead: () => sha('a'),
      now: () => made.clock.now().getTime(),
      spawn: async (run) => {
        const lines: [number, object][] = [
          [4, { type: 'system', subtype: 'init' }],
          [11, { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: TREE_GATE } }] } }],
          [25, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } }],
        ]
        for (const [after, line] of lines) {
          seconds(after)
          run.onLine?.(JSON.stringify(line))
        }
        writeFileSync(run.stdoutPath, '')
        return ending(dir, lease.leaseGen)
      },
      newSession: () => NEW_SESSION,
      publish: () => {},
    })
    const cardTrees: CardTreeTools = { home: trees, exists: existsSync, branchOf: pr => `feat/card-${pr}`, recreate: () => {}, bringTo: () => {} }
    const parts = { db: made.db, ownerMerges: () => '', clock: made.clock.now, trees: cardTrees }
    const executor = new AnswerExecutor({ ...parts, answerer, liveSession: () => {
      seconds(2)
      return null
    }, prepare: () => seconds(48) })
    return { made, lease, executor, parts }
  }

  const asksTheOwner = (dir: string, leaseGen: number): number => {
    writeFileSync(ownerQuestionPath(dir, CARD_SESSION, leaseGen), 'which of the two does the card mean?\n')
    return 0
  }

  it('an answer round that stops leaves one bus event per step with its seconds', async () => {
    const { made, lease, executor } = round(asksTheOwner)

    expect(await executor.answer(lease)).toMatchObject({ kind: 'stopped', reason: QUESTION_AGENT })
    expect(eventsOf(made.db, ANSWER_STEP)).toEqual(SESSION_THAT_REACHED_THE_GATE)
  })

  it('an answer round whose session fails is denied and keeps its steps', async () => {
    const { made, lease, executor } = round(() => 1)

    expect(await executor.answer(lease)).toMatchObject({ kind: 'denied', denial: { reason: 'answer_failed' } })
    expect(eventsOf(made.db, ANSWER_STEP)).toEqual(SESSION_THAT_REACHED_THE_GATE)
  })

  it('a step the bus refuses to record does not change how the round ends', async () => {
    const { made, lease, executor } = round(asksTheOwner)
    const missed = vi.spyOn(console, 'error').mockImplementation(() => {})
    made.db.exec(`CREATE TRIGGER refuse_steps BEFORE INSERT ON events WHEN NEW.type = '${ANSWER_STEP}' BEGIN SELECT RAISE(ABORT, 'the bus is busy'); END`)

    expect(await executor.answer(lease)).toMatchObject({ kind: 'stopped', reason: QUESTION_AGENT })
    expect(missed).toHaveBeenCalledWith(expect.stringContaining('the steps of the round were not recorded: the bus is busy'))
  })

  it.each([
    ['pnpm typecheck', 'pnpm typecheck', 7],
    ['pnpm typecheck', 'pnpm --dir /trees/mc-905 typecheck', 7],
    ['pnpm typecheck', 'pnpm --dir /trees/mc-905 run typecheck', 7],
    ['pnpm exec node --import tsx scripts/ci/prepush.ts --round abc', 'pnpm --dir /trees/mc-905 exec node --import tsx scripts/ci/prepush.ts --round abc', 7],
    ['pnpm run quality', 'pnpm --dir /trees/mc-905 run quality', 7],
    ['pnpm typecheck', 'pnpm --dir /trees/mc-905 exec vitest run', null],
  ])('the gate %s counts the session command %s as %s seconds', (gate, command, seconds) => {
    let now = 0
    const timer = new RoundTimer(() => now, [gate])
    timer.line(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command } }] } }))
    now = 7_000
    timer.line(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1' }] } }))

    expect(timer.steps().gate).toBe(seconds)
  })

  it('a second session in one lease writes its steps beside those of the first', async () => {
    const { made, lease, parts } = round(() => 0)
    const sessions: boolean[] = []
    const executor = new AnswerExecutor({ ...parts, dirty: () => false, liveSession: () => null, prepare: () => made.clock.advance(1_000), answerer: async (request) => {
      sessions.push(request.fresh === true)
      return { session: NEW_SESSION, resumed: false, atContextWarn: sessions.length === 1, before: sha('a'), after: sessions.length === 1 ? sha('a') : sha('e'), owner: null }
    } })

    expect(await executor.answer(lease)).toMatchObject({ kind: 'answered' })
    expect(sessions).toEqual([false, true])
    expect(eventsOf(made.db, ANSWER_STEP).map(event => event.step)).toEqual(['lease', 'tree', 'lease', 'tree'])
  })
})
