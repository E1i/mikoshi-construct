import type { CardBodyReader } from '../../intake/parking-reads.js'
import type { CardScope, DepthSources, ReviewPlanner } from './review-depth.js'
import { execFileSync } from 'node:child_process'
import { runsOf } from '../../../src/card/covering-tests.js'
import { parseParkingFile } from '../../../src/card/parking.js'
import { predict } from '../../policy/morse/predict.js'
import { planReview } from './review-depth.js'

const MAIN = 'origin/main'

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function cardScope(bodyOf: CardBodyReader, cardId: number): CardScope | null {
  const text = bodyOf(cardId)
  if (text === null)
    return null
  const parsed = parseParkingFile(`${cardId}.md`, text)
  return parsed.kind === 'parked' ? { touches: parsed.parked.task.touches, runs: runsOf(parsed.parked.task.body) } : null
}

export function gitDepthSources(repo: string, journal: string, bodyOf: CardBodyReader): DepthSources {
  return {
    base: head => git(repo, ['merge-base', MAIN, head]).trim(),
    changed: (from, to) => git(repo, ['diff', '--no-renames', '--name-only', '-z', from, to]).split('\0').filter(file => file !== ''),
    predict: (task, base, head) => {
      const { line, files } = predict({ task, base, head, journal, repo })
      return { prediction: line, files: files.map(file => file.path) }
    },
    scope: cardId => cardScope(bodyOf, cardId),
  }
}

export function gitReviewPlanner(repo: string, journal: string, bodyOf: CardBodyReader): ReviewPlanner {
  const sources = gitDepthSources(repo, journal, bodyOf)
  return (lease, earlier) => {
    if (lease.pr !== null)
      git(repo, ['fetch', '--quiet', 'origin', 'main', `pull/${lease.pr}/head`])
    return planReview(lease, earlier, sources)
  }
}
