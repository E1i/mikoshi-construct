import type { PrReview } from '../../../shift/merge.js'
import { PR_REVIEW_EVENT } from '../../../shift/merge.js'

export function prReviewLine(review: PrReview, now: Date): string {
  return `${JSON.stringify({ event: PR_REVIEW_EVENT, task: review.task, pr: review.pr, verdict: review.verdict, commit: review.commit, ts: now.toISOString() })}\n`
}
