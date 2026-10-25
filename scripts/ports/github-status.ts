import type { GhPort } from './gh.js'
import { GhFailed, PROCESS_GH_PORT } from './gh.js'

export const REVIEW_STATUS_CONTEXT = 'review'

export interface ReviewStatus {
  commit: string
  state: 'success' | 'failure'
  context: typeof REVIEW_STATUS_CONTEXT
  description: string
}

export type StatusPublisher = (status: ReviewStatus) => void

export function ghStatusPublisher(repo: string, port: GhPort = PROCESS_GH_PORT): StatusPublisher {
  return (status) => {
    const posted = port.call(['api', '--method', 'POST', `repos/{owner}/{repo}/statuses/${status.commit}`, '-f', `state=${status.state}`, '-f', `context=${status.context}`, '-f', `description=${status.description}`], { cwd: repo })
    if (posted.kind === 'failed')
      throw new GhFailed(posted)
  }
}
