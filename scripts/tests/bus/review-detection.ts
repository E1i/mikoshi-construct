import type { Scope } from '../../bus/node.js'
import type { StoredEvent } from '../../bus/stored.js'
import type { MergeBench } from './merge-bench.js'
import { fullReview } from '../../bus/review-depth.js'
import { ReviewNode } from '../../bus/review-worker.js'
import { STORED_COLUMNS } from '../../bus/stored.js'

class DetectingReviewNode extends ReviewNode {
  detect(scope?: Scope): void {
    const latest = this.db.prepare(`SELECT ${STORED_COLUMNS} FROM events ORDER BY id DESC LIMIT 1`).get() as unknown as StoredEvent
    this.detectOn(latest, scope)
  }
}

export function detectReview(bench: Pick<MergeBench, 'db' | 'gitHub' | 'clock'>, scope?: Scope): void {
  new DetectingReviewNode({ db: bench.db, gitHub: bench.gitHub.client, publish: bench.gitHub.publish, reviewer: async () => ({ verdict: 'pass', findings: [], session: 'detect' }), plan: () => fullReview('detection only'), clock: bench.clock.now, session: 'detect', mode: 'live', env: {} }).detect(scope)
}
