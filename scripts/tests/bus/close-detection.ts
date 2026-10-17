import type { DatabaseSync } from 'node:sqlite'
import type { Scope } from '../../bus/node.js'
import type { StoredEvent } from '../../bus/stored.js'
import { CloseNode } from '../../bus/close-worker.js'
import { STORED_COLUMNS } from '../../bus/stored.js'

class DetectingCloseNode extends CloseNode {
  detect(scope?: Scope): void {
    const latest = this.db.prepare(`SELECT ${STORED_COLUMNS} FROM events ORDER BY id DESC LIMIT 1`).get() as unknown as StoredEvent
    this.detectOn(latest, scope)
  }
}

export function detectClose(db: DatabaseSync, clock: () => Date, scope?: Scope): void {
  new DetectingCloseNode({ db, reported: () => null, clock, session: 'detect', journal: '/nonexistent/ghosts.jsonl', parking: '/nonexistent/parking', mode: 'live', env: {} }).detect(scope)
}
