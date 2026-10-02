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

export type PrLookup = { kind: 'found', pr: PullRequest, via?: string } | { kind: 'none' } | { kind: 'unknown', missing: string }

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

export function lookupPrVia(list: PrList, branch: string): PrLookup {
  const pr = lookupPr(list, branch)
  return pr.kind === 'found' ? { ...pr, via: branch } : pr
}

export function lookupGhostPr(list: PrList, id: string): PrLookup {
  const branch = `ghost/${id}`
  const pr = lookupPrVia(list, branch)
  return pr.kind === 'none' ? { kind: 'unknown', missing: `branch; no tasks file names one, and no PR for ${branch}` } : pr
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

export const REQUIRED_CHECK = 'required'

export interface Ci {
  state: CiState
  text: string
  head: string
  greenAt?: string
}

export interface PrDetails {
  ci: Ci
  files: string[] | undefined
}

function outcomeOf(check: Check): string | undefined {
  return check.conclusion ?? check.state
}

function isFailing(check: Check): boolean {
  const outcome = outcomeOf(check)
  return outcome !== undefined && outcome !== '' && !PASSING.includes(outcome)
}

function ciOf(checks: Check[], head: string): Ci {
  if (checks.length === 0)
    return { state: 'none', text: `— (no checks recorded on ${head})`, head }
  const required = checks.find(check => check.name === REQUIRED_CHECK)
  if (required === undefined)
    return { state: 'pending', text: `pending (${REQUIRED_CHECK} not reported) on ${head}`, head }
  const pending = checks.filter(check => check.status !== undefined && check.status !== 'COMPLETED')
  if (pending.includes(required))
    return { state: 'pending', text: `pending (${pending.length} of ${checks.length}) on ${head}`, head }
  if (outcomeOf(required) !== 'SUCCESS') {
    const failing = checks.filter(check => check === required || isFailing(check))
    return { state: 'red', text: `red (${failing.map(check => check.name ?? '?').join(', ')}) on ${head}`, head }
  }
  const at = required.completedAt
  return at === undefined
    ? { state: 'green', text: `green on ${head}`, head }
    : { state: 'green', text: `green ${at} on ${head}`, head, greenAt: at }
}

export function prDetails(gh: GhRunner, repo: string, pr: PullRequest): PrDetails {
  let view: { headRefOid?: string, statusCheckRollup?: Check[], files?: { path: string }[] }
  try {
    view = JSON.parse(gh(['pr', 'view', String(pr.number), '-R', repo, '--json', 'headRefOid,statusCheckRollup,files'])) as typeof view
  }
  catch {
    return { ci: { state: 'unknown', text: 'UNKNOWN (missing: checks; the gh query failed)', head: pr.headRefOid.slice(0, 7) }, files: undefined }
  }
  return { ci: ciOf(view.statusCheckRollup ?? [], (view.headRefOid ?? pr.headRefOid).slice(0, 7)), files: view.files?.map(file => file.path) }
}
