import { execFileSync } from 'node:child_process'

export type GhRunner = (args: string[]) => string

export interface PullRequest {
  number: number
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
    const prs = JSON.parse(gh(['pr', 'list', '-R', repo, '--state', 'all', '--limit', String(PR_LIST_LIMIT), '--json', 'number,headRefName,headRefOid,state,mergedAt,mergeCommit'])) as PullRequest[]
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

export function prChecks(gh: GhRunner, repo: string, pr: PullRequest): string {
  let checks: Check[]
  try {
    checks = (JSON.parse(gh(['pr', 'view', String(pr.number), '-R', repo, '--json', 'statusCheckRollup'])) as { statusCheckRollup?: Check[] }).statusCheckRollup ?? []
  }
  catch {
    return 'UNKNOWN (missing: checks; the gh query failed)'
  }
  const sha = pr.headRefOid.slice(0, 7)
  if (checks.length === 0)
    return `— (no checks recorded on ${sha})`
  const pending = checks.filter(check => check.status !== undefined && check.status !== 'COMPLETED')
  if (pending.length > 0)
    return `pending (${pending.length} of ${checks.length}) on ${sha}`
  const failing = checks.filter((check) => {
    const outcome = check.conclusion ?? check.state
    return outcome !== undefined && outcome !== '' && !PASSING.includes(outcome)
  })
  if (failing.length > 0)
    return `red (${failing.map(check => check.name ?? '?').join(', ')}) on ${sha}`
  const last = checks.map(check => check.completedAt).filter(Boolean).sort().at(-1)
  return last === undefined ? `green on ${sha}` : `green ${last} on ${sha}`
}
