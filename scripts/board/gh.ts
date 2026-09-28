import { execFileSync } from 'node:child_process'

export type GhRunner = (args: string[]) => string

export interface PullRequest {
  number: number
  title?: string
  headRefName: string
  headRefOid: string
  state: string
  mergedAt: string | null
  mergeCommit: { oid: string } | null
}

export type PrList = { kind: 'failed' } | { kind: 'listed', prs: PullRequest[], truncated: boolean }

export type PrLookup = { kind: 'found', pr: PullRequest } | { kind: 'none' } | { kind: 'unknown', missing: string }

interface Check {
  name?: string
  status?: string
  conclusion?: string
  state?: string
  completedAt?: string
}

export const PR_LIST_LIMIT = 1000

const PASSING = ['SUCCESS', 'SKIPPED', 'NEUTRAL']

export const execGh: GhRunner = args => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

export function listPrs(gh: GhRunner, repo: string): PrList {
  try {
    const prs = JSON.parse(gh(['pr', 'list', '-R', repo, '--state', 'all', '--limit', String(PR_LIST_LIMIT), '--json', 'number,title,headRefName,headRefOid,state,mergedAt,mergeCommit'])) as PullRequest[]
    return { kind: 'listed', prs, truncated: prs.length >= PR_LIST_LIMIT }
  }
  catch {
    return { kind: 'failed' }
  }
}

export function lookupPr(list: PrList, branch: string | undefined): PrLookup {
  if (branch === undefined)
    return { kind: 'unknown', missing: 'branch; no tasks file names one' }
  if (list.kind === 'failed')
    return { kind: 'unknown', missing: 'pr; the gh query failed' }
  const pr = list.prs.find(candidate => candidate.headRefName === branch)
  if (pr !== undefined)
    return { kind: 'found', pr }
  if (list.truncated)
    return { kind: 'unknown', missing: `pr; the gh list stopped at ${PR_LIST_LIMIT}` }
  return { kind: 'none' }
}

export function lookupPrNumber(list: PrList, number: number | undefined): PrLookup {
  if (number === undefined)
    return { kind: 'unknown', missing: 'pr; the journal event:path line records none' }
  if (list.kind === 'failed')
    return { kind: 'unknown', missing: 'pr; the gh query failed' }
  const pr = list.prs.find(candidate => candidate.number === number)
  if (pr !== undefined)
    return { kind: 'found', pr }
  if (list.truncated)
    return { kind: 'unknown', missing: `pr #${number}; the gh list stopped at ${PR_LIST_LIMIT}` }
  return { kind: 'unknown', missing: `pr #${number}; not in the gh list` }
}

export type CiState = 'none' | 'pending' | 'red' | 'green' | 'unknown'

export interface PrDetails {
  ci: { state: CiState, text: string }
  files: string[] | undefined
}

function ciOf(checks: Check[], sha: string): PrDetails['ci'] {
  if (checks.length === 0)
    return { state: 'none', text: `— (no checks recorded on ${sha})` }
  const pending = checks.filter(check => check.status !== undefined && check.status !== 'COMPLETED')
  if (pending.length > 0)
    return { state: 'pending', text: `pending (${pending.length} of ${checks.length}) on ${sha}` }
  const failing = checks.filter((check) => {
    const outcome = check.conclusion ?? check.state
    return outcome !== undefined && outcome !== '' && !PASSING.includes(outcome)
  })
  if (failing.length > 0)
    return { state: 'red', text: `red (${failing.map(check => check.name ?? '?').join(', ')}) on ${sha}` }
  const last = checks.map(check => check.completedAt).filter(Boolean).sort().at(-1)
  return { state: 'green', text: last === undefined ? `green on ${sha}` : `green ${last} on ${sha}` }
}

export function prDetails(gh: GhRunner, repo: string, pr: PullRequest): PrDetails {
  let view: { statusCheckRollup?: Check[], files?: { path: string }[] }
  try {
    view = JSON.parse(gh(['pr', 'view', String(pr.number), '-R', repo, '--json', 'statusCheckRollup,files'])) as typeof view
  }
  catch {
    return { ci: { state: 'unknown', text: 'UNKNOWN (missing: checks; the gh query failed)' }, files: undefined }
  }
  return { ci: ciOf(view.statusCheckRollup ?? [], pr.headRefOid.slice(0, 7)), files: view.files?.map(file => file.path) }
}
