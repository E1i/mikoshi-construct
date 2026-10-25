import type { Scope } from '../../core/node.js'
import type { StoredEvent } from '../../core/stored.js'
import type { IsolationReader } from '../../ports/isolation.js'
import type { MergeBench } from './merge-bench.js'
import { STORED_COLUMNS } from '../../core/stored.js'
import { fullReview } from '../../nodes/review/review-depth.js'
import { ReviewNode } from '../../nodes/review/review-worker.js'

const sandboxed: IsolationReader = () => ({ level: 'full', mechanism: 'claude-code-sandbox', gaps: [] })

class DetectingReviewNode extends ReviewNode {
  detect(scope?: Scope): void {
    const latest = this.db.prepare(`SELECT ${STORED_COLUMNS} FROM events ORDER BY id DESC LIMIT 1`).get() as unknown as StoredEvent
    this.detectOn(latest, scope)
  }
}

export function detectReview(bench: Pick<MergeBench, 'db' | 'gitHub' | 'clock'>, scope?: Scope): void {
  new DetectingReviewNode({ db: bench.db, gitHub: bench.gitHub.client, publish: bench.gitHub.publish, reviewer: async () => ({ verdict: 'pass', findings: [], session: 'detect' }), plan: () => fullReview('detection only'), clock: bench.clock.now, session: 'detect', mode: 'live', env: {}, isolation: sandboxed }).detect(scope)
}
