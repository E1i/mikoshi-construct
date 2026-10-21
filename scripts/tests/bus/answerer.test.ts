import type { AnswerRequest, AnswerRun } from '../../bus/answerer.js'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { claudeAnswerer } from '../../bus/answerer.js'

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
