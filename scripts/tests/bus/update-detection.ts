import type { Scope } from '../../bus/node.js'
import type { StoredEvent } from '../../bus/stored.js'
import type { MergeBench } from './merge-bench.js'
import { STORED_COLUMNS } from '../../bus/stored.js'
import { UpdateNode } from '../../bus/update-worker.js'

class DetectingUpdateNode extends UpdateNode {
  detect(scope?: Scope): void {
    const latest = this.db.prepare(`SELECT ${STORED_COLUMNS} FROM events ORDER BY id DESC LIMIT 1`).get() as unknown as StoredEvent
    this.detectOn(latest, scope)
  }
}

export function detectUpdate(bench: Pick<MergeBench, 'db' | 'gitHub' | 'clock'>, scope?: Scope): void {
  new DetectingUpdateNode({ db: bench.db, gitHub: bench.gitHub.client, put: bench.gitHub.put, publish: bench.gitHub.publish, clock: bench.clock.now, settle: () => {}, session: 'detect', mode: 'live', env: {} }).detect(scope)
}
