import type { CardBodyReader } from '../../intake/parking-reads.js'
import type { CardScope, DepthSources, ReviewPlanner } from './review-depth.js'
import { execFileSync } from 'node:child_process'
import { runsOf } from '../../../src/card/covering-tests.js'
import { parseParkingFile } from '../../../src/card/parking.js'
import { predict } from '../../policy/morse/predict.js'
import { planReview } from './review-depth.js'

const MAIN = 'origin/main'

const CONCURRENT_REF_UPDATE = 'cannot lock ref'

export type GitRun = (repo: string, args: string[]) => string

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function lostRefRace(error: unknown): boolean {
  const stderr = (error as { stderr?: unknown } | null)?.stderr
  const text = `${error instanceof Error ? error.message : ''}${typeof stderr === 'string' ? stderr : ''}`
  return text.includes(CONCURRENT_REF_UPDATE)
}

function fetchPr(run: GitRun, repo: string, pr: number): void {
  const args = ['fetch', '--quiet', 'origin', 'main', `pull/${pr}/head`]
  try {
    run(repo, args)
  }
  catch (error) {
    if (!lostRefRace(error))
      throw error
    run(repo, args)
  }
}

function cardScope(bodyOf: CardBodyReader, cardId: number): CardScope | null {
  const text = bodyOf(cardId)
  if (text === null)
    return null
  const parsed = parseParkingFile(`${cardId}.md`, text)
  return parsed.kind === 'parked' ? { touches: parsed.parked.task.touches, runs: runsOf(parsed.parked.task.body) } : null
}

export function gitDepthSources(repo: string, journal: string, bodyOf: CardBodyReader, run: GitRun = git): DepthSources {
  return {
    base: head => run(repo, ['merge-base', MAIN, head]).trim(),
    changed: (from, to) => run(repo, ['diff', '--no-renames', '--name-only', '-z', from, to]).split('\0').filter(file => file !== ''),
    predict: (task, base, head) => {
      const { line, files } = predict({ task, base, head, journal, repo })
      return { prediction: line, files: files.map(file => file.path) }
    },
    scope: cardId => cardScope(bodyOf, cardId),
  }
}

export function gitReviewPlanner(repo: string, journal: string, bodyOf: CardBodyReader, run: GitRun = git): ReviewPlanner {
  const sources = gitDepthSources(repo, journal, bodyOf, run)
  return (lease, earlier) => {
    if (lease.pr !== null)
      fetchPr(run, repo, lease.pr)
    return planReview(lease, earlier, sources)
  }
}
