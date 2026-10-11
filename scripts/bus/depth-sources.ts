import type { DepthSources, ReviewPlanner } from './review-depth.js'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { parseParkingFile } from '../../src/card/parking.js'
import { predict } from '../morse/predict.js'
import { parkedCardFile } from './card-archive.js'
import { planReview } from './review-depth.js'

const MAIN = 'origin/main'

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function cardTouches(parking: string, cardId: number): string[] | null {
  const file = parkedCardFile(parking, cardId)
  if (file === undefined)
    return null
  const parsed = parseParkingFile(path.basename(file), readFileSync(file, 'utf8'))
  return parsed.kind === 'parked' ? parsed.parked.task.touches : null
}

export function gitDepthSources(repo: string, journal: string, parking: string): DepthSources {
  return {
    base: head => git(repo, ['merge-base', MAIN, head]).trim(),
    changed: (from, to) => git(repo, ['diff', '--no-renames', '--name-only', '-z', from, to]).split('\0').filter(file => file !== ''),
    predict: (task, base, head) => {
      const { line, files } = predict({ task, base, head, journal, repo })
      return { prediction: line, files: files.map(file => file.path) }
    },
    touches: cardId => cardTouches(parking, cardId),
  }
}

export function gitReviewPlanner(repo: string, journal: string, parking: string): ReviewPlanner {
  const sources = gitDepthSources(repo, journal, parking)
  return (lease, earlier) => {
    if (lease.pr !== null)
      git(repo, ['fetch', '--quiet', 'origin', 'main', `pull/${lease.pr}/head`])
    return planReview(lease, earlier, sources)
  }
}
