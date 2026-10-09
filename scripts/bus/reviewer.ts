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

const VERDICTS = new Set<string>(['pass', 'changes'])

export function reviewOf(text: string, session: string): Review {
  const parsed = JSON.parse(text) as { verdict?: unknown, findings?: unknown }
  if (typeof parsed.verdict !== 'string' || !VERDICTS.has(parsed.verdict))
    throw new Error(`the review of session ${session} names no verdict pass | changes`)
  if (!Array.isArray(parsed.findings) || !parsed.findings.every(finding => typeof finding === 'string'))
    throw new Error(`the review of session ${session} has no findings list of strings`)
  return { verdict: parsed.verdict as VerdictWord, findings: parsed.findings as string[], session }
}

export function reviewPrompt(lease: Lease, verdictPath: string): string {
  return [
    `[review:${lease.taskKey}]`,
    `Act as the review role defined in .claude/agents/review.md. This tree is pull request #${lease.pr} of card #${lease.cardId}, checked out at its head ${lease.head}.`,
    `Review it against its card (the first line of the pull request description) and the repository's rules. Change nothing, commit nothing, push nothing, and post nothing to GitHub.`,
    `Finish by writing ${verdictPath} as JSON: {"verdict": "pass" | "changes", "findings": ["one finding per string"]}.`,
  ].join('\n')
}

function git(cwd: string, args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
}

export function claudeReviewer(repo: string, dir: string): Reviewer {
  return async (lease) => {
    const session = randomUUID()
    const tree = path.join(dir, session)
    const verdictPath = path.join(dir, `${session}.verdict.json`)
    mkdirSync(dir, { recursive: true })
    git(repo, ['fetch', '--quiet', 'origin', `pull/${lease.pr}/head`])
    git(repo, ['worktree', 'add', '--detach', tree, lease.head!])
    try {
      const code = await spawnSession({ cwd: tree, sessionId: session, prompt: reviewPrompt(lease, verdictPath), stdoutPath: path.join(dir, `${session}.out.jsonl`), stderrPath: path.join(dir, `${session}.err.log`) })
      if (code !== 0)
        throw new Error(`the review session ${session} exited ${code}`)
      return reviewOf(readFileSync(verdictPath, 'utf8'), session)
    }
    finally {
      git(repo, ['worktree', 'remove', '--force', tree])
    }
  }
}
