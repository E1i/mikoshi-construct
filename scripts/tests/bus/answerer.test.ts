import type { AnswerRequest, AnswerRun } from '../../bus/answerer.js'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { claudeAnswerer, FreshBaseConflict, ownerQuestionPath, realAnswererTools } from '../../bus/answerer.js'

const CARD_SESSION = 'card-session-1207'
const NEW_SESSION = 'new-session-1'
const CONTEXT_WARN = 200_000
const CARD_BODY = '#1207 answer-starts-fresh [implement/netwatch/S/cheap/owner]\n\nthe card body'
const DIFF = 'diff --git a/scripts/bus/answerer.ts b/scripts/bus/answerer.ts\n+the change so far'
const FINDING = 'the retry is missing'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function requestIn(root: string): AnswerRequest {
  const worktree = path.join(root, 'mc-1207')
  mkdirSync(worktree, { recursive: true })
  return {
    lease: { taskKey: 'answer:1207:1300', queue: 'answer', cardId: 1207, pr: 1300, head: 'a'.repeat(40), leaseGen: 1, actor: 'worker:answer:worker-1' },
    source: { kind: 'changes', findings: [FINDING], events: [] },
    widened: null,
    card: { session: CARD_SESSION, worktree, branch: 'feat/card-1207' },
  }
}

async function answerAt(context: number) {
  const root = mkdtempSync(path.join(tmpdir(), 'bus-answerer-'))
  roots.push(root)
  const runs: AnswerRun[] = []
  const published: string[] = []
  const heads = ['a'.repeat(40), 'e'.repeat(40)]
  const request = requestIn(root)
  const answerer = claudeAnswerer(path.join(root, 'answers'), {
    cardText: () => CARD_BODY,
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

    realAnswererTools(path.join(root, 'parking'), path.join(root, 'bus.db')).publish({ session: CARD_SESSION, worktree, branch: 'feat/card-1207' }, 'answer for #1207')

    const fresh = git(upstream, ['rev-parse', 'main']).trim()
    expect({ onFreshBase: git(worktree, ['merge-base', fresh, 'origin/feat/card-1207']).trim() === fresh, merges: git(worktree, ['rev-list', '--merges', '--count', `${fresh}..origin/feat/card-1207`]).trim() }).toEqual({ onFreshBase: true, merges: '1' })
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
      return { owner: answered.owner, runs: runs.length, merge: runs[1]?.argv.at(-1)?.includes('resolve every conflict in a.md') }
    }))

    expect(outcomes).toEqual([
      { owner: null, runs: 2, merge: true },
      { owner: 'merging a fresh origin/main into feat/card-1207 conflicts in a.md and the answer session did not resolve it', runs: 2, merge: true },
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
