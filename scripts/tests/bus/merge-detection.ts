import type { Scope } from '../../bus/node.js'
import type { StoredEvent } from '../../bus/stored.js'
import type { MergeBench } from './merge-bench.js'
import { MergeNode } from '../../bus/merge-worker.js'
import { STORED_COLUMNS } from '../../bus/stored.js'

class DetectingMergeNode extends MergeNode {
  detect(scope?: Scope): void {
    const latest = this.db.prepare(`SELECT ${STORED_COLUMNS} FROM events ORDER BY id DESC LIMIT 1`).get() as unknown as StoredEvent
    this.detectOn(latest, scope)
  }
}

export function detectMerge(bench: Pick<MergeBench, 'db' | 'gitHub' | 'clock'>, scope?: Scope): void {
  new DetectingMergeNode({ db: bench.db, gitHub: bench.gitHub.client, put: bench.gitHub.put, publish: bench.gitHub.publish, clock: bench.clock.now, session: 'detect', run: null, mode: 'live', env: {} }).detect(scope)
}
