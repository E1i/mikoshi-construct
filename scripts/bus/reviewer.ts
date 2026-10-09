import type { SpawnSessionParams } from '../ghosts/session.js'
import type { Lease } from './lease.js'
import type { VerdictWord } from './record-verdict.js'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { spawnSession } from '../ghosts/session.js'

export interface Review {
  verdict: VerdictWord
  findings: string[]
  session: string
}

export type Reviewer = (lease: Lease) => Promise<Review>

export interface ReviewerTools {
  git: (cwd: string, args: string[]) => void
  spawn: (params: SpawnSessionParams) => Promise<number>
}

export const PREFIX = '[bus:review] '

const VERDICTS = new Set<string>(['pass', 'changes'])

export function reviewOf(text: string, session: string): Review {
  const parsed = JSON.parse(text) as { verdict?: unknown, findings?: unknown }
  if (typeof parsed.verdict !== 'string' || !VERDICTS.has(parsed.verdict))
    throw new Error(`the review of session ${session} names no verdict pass | changes`)
  if (!Array.isArray(parsed.findings) || !parsed.findings.every(finding => typeof finding === 'string'))
    throw new Error(`the review of session ${session} has no findings list of strings`)
  return { verdict: parsed.verdict as VerdictWord, findings: parsed.findings as string[], session }
}

export function reviewPrompt(lease: Lease, tree: string, verdictPath: string): string {
  return [
    `[review:${lease.taskKey}]`,
    `Act as the review role defined in .claude/agents/review.md. Pull request #${lease.pr} of card #${lease.cardId} is checked out at ${tree}, at its head ${lease.head}; read it there.`,
    `Review it against its card (the first line of the pull request description) and the repository's rules. Change nothing, commit nothing, push nothing, and post nothing to GitHub.`,
    `Finish by writing ${verdictPath} as JSON: {"verdict": "pass" | "changes", "findings": ["one finding per string"]}.`,
  ].join('\n')
}

function git(cwd: string, args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
}

const REAL_TOOLS: ReviewerTools = { git, spawn: spawnSession }

function removeTree(tools: ReviewerTools, repo: string, tree: string): void {
  try {
    tools.git(repo, ['worktree', 'remove', '--force', tree])
  }
  catch (error) {
    console.error(`${PREFIX}could not remove the review tree ${tree}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function reviewSession(repo: string, dir: string, session: string, lease: Lease): SpawnSessionParams & { tree: string, verdictPath: string } {
  const tree = path.join(dir, session)
  const verdictPath = path.join(dir, `${session}.verdict.json`)
  return {
    cwd: repo,
    addDirs: [dir],
    sessionId: session,
    prompt: reviewPrompt(lease, tree, verdictPath),
    stdoutPath: path.join(dir, `${session}.out.jsonl`),
    stderrPath: path.join(dir, `${session}.err.log`),
    tree,
    verdictPath,
  }
}

export function claudeReviewer(repo: string, dir: string, tools: ReviewerTools = REAL_TOOLS): Reviewer {
  return async (lease) => {
    const session = randomUUID()
    const { tree, verdictPath, ...params } = reviewSession(repo, dir, session, lease)
    mkdirSync(dir, { recursive: true })
    tools.git(repo, ['fetch', '--quiet', 'origin', `pull/${lease.pr}/head`])
    tools.git(repo, ['worktree', 'add', '--detach', tree, lease.head!])
    try {
      const code = await tools.spawn(params)
      if (code !== 0)
        throw new Error(`the review session ${session} exited ${code}`)
      return reviewOf(readFileSync(verdictPath, 'utf8'), session)
    }
    finally {
      removeTree(tools, repo, tree)
    }
  }
}
