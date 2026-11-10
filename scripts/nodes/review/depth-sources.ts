import type { BusCatalog } from '../../ci/card-runs.js'
import type { CardBodyReader } from '../../intake/parking-reads.js'
import type { CardScope, DepthSources, ReviewPlanner } from './review-depth.js'
import { layerMasksOf, runsOf } from '../../../src/card/covering-tests.js'
import { createdPaths, parseParkingFile } from '../../../src/card/parking.js'
import { busCheckCatalog, cardReadingOf } from '../../ci/card-runs.js'
import { predict } from '../../policy/morse/predict.js'
import { processGit } from '../../ports/git.js'
import { planReview } from './review-depth.js'

const MAIN = 'origin/main'

const CONCURRENT_REF_UPDATE = 'cannot lock ref'

export type GitRun = (repo: string, args: string[]) => string

function git(repo: string, args: string[]): string {
  return processGit.read(repo, args)
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

function cardScope(bodyOf: CardBodyReader, cardId: number, catalog: () => BusCatalog): CardScope | null {
  const text = bodyOf(cardId)
  if (text === null)
    return null
  const parsed = parseParkingFile(`${cardId}.md`, text)
  if (parsed.kind !== 'parked')
    return null
  const { touches, body } = parsed.parked.task
  return { touches, creates: createdPaths(parsed.parked.creates), ...cardReadingOf(touches, runsOf(body), layerMasksOf(body), catalog()) }
}

export function gitDepthSources(repo: string, journal: string, bodyOf: CardBodyReader, run: GitRun = git, catalog: () => BusCatalog = busCheckCatalog): DepthSources {
  return {
    base: head => run(repo, ['merge-base', MAIN, head]).trim(),
    changed: (from, to) => run(repo, ['diff', '--no-renames', '--name-only', '-z', from, to]).split('\0').filter(file => file !== ''),
    predict: (task, base, head) => {
      const { line, files } = predict({ task, base, head, journal, repo })
      return { prediction: line, files: files.map(file => file.path), added: files.filter(file => file.status === 'A').map(file => file.path) }
    },
    scope: cardId => cardScope(bodyOf, cardId, catalog),
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
