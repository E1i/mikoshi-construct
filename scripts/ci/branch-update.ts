import { REVIEW_STATUS_CONTEXT } from '../ghosts/verdict.js'

export const TOKEN_SECRET = 'BRANCH_UPDATE_TOKEN'

export type Mergeable = 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN'

export interface OpenPullRequest {
  number: number
  createdAt: string
  isDraft: boolean
  isCrossRepository: boolean
  autoMerge: boolean
  mergeable: Mergeable
  behindBy: number
  hasReviewStatus: boolean
}

export interface HeadCommits {
  nodes: { commit: { status: { contexts: { context: string }[] } | null } }[]
}

export function carriesReviewStatus(commits: HeadCommits): boolean {
  return commits.nodes.some(({ commit }) => commit.status?.contexts.some(({ context }) => context === REVIEW_STATUS_CONTEXT) ?? false)
}

export function isWaitingForUpdate(pr: OpenPullRequest): boolean {
  return pr.autoMerge && !pr.isDraft && !pr.isCrossRepository && pr.mergeable !== 'CONFLICTING' && pr.behindBy > 0 && !pr.hasReviewStatus
}

function oldestFirst(a: OpenPullRequest, b: OpenPullRequest): number {
  return Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.number - b.number
}

export function nextToUpdate(prs: readonly OpenPullRequest[]): OpenPullRequest | undefined {
  return prs.filter(isWaitingForUpdate).sort(oldestFirst)[0]
}
