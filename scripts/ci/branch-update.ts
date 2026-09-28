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
}

export function isWaitingForUpdate(pr: OpenPullRequest): boolean {
  return pr.autoMerge && !pr.isDraft && !pr.isCrossRepository && pr.mergeable !== 'CONFLICTING' && pr.behindBy > 0
}

function oldestFirst(a: OpenPullRequest, b: OpenPullRequest): number {
  return Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.number - b.number
}

export function nextToUpdate(prs: readonly OpenPullRequest[]): OpenPullRequest | undefined {
  return prs.filter(isWaitingForUpdate).sort(oldestFirst)[0]
}
