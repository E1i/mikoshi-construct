import type { DepthSources, ReviewPlanner } from './review-depth.js'
import { execFileSync } from 'node:child_process'
import { predict } from '../morse/predict.js'
import { planReview } from './review-depth.js'

const MAIN = 'origin/main'

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

export function gitDepthSources(repo: string, journal: string): DepthSources {
  return {
    base: head => git(repo, ['merge-base', MAIN, head]).trim(),
    changed: (from, to) => git(repo, ['diff', '--no-renames', '--name-only', '-z', from, to]).split('\0').filter(file => file !== ''),
    predict: (task, base, head) => predict({ task, base, head, journal, repo }).line,
  }
}

export function gitReviewPlanner(repo: string, journal: string): ReviewPlanner {
  const sources = gitDepthSources(repo, journal)
  return (lease, earlier) => {
    if (lease.pr !== null)
      git(repo, ['fetch', '--quiet', 'origin', 'main', `pull/${lease.pr}/head`])
    return planReview(lease, earlier, sources)
  }
}
