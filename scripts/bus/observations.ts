import type { BusEvent } from './db.js'
import type { ClosedPr, MainHead, OpenPr, Snapshot } from './snapshot.js'
import { createHash } from 'node:crypto'

export const NETWATCH = 'netwatch'

function observation(ts: string, type: string, fields: Pick<BusEvent, 'cardId' | 'pr' | 'head' | 'dedupeKey' | 'payload'>): BusEvent {
  return { ts, type, actor: NETWATCH, legacy: false, ...fields }
}

export function prObserved(ts: string, open: OpenPr): BusEvent {
  const payload = {
    base: open.base,
    head: open.head,
    mergeable: open.mergeable,
    ci: open.ci,
    ...(open.verdictOnHead === null ? {} : { verdict_on_head: open.verdictOnHead }),
    auto_merge: open.autoMerge,
    draft: open.draft,
  }
  const digest = createHash('sha256').update(JSON.stringify(payload)).digest('hex')
  return observation(ts, 'pr.observed', { cardId: open.cardId, pr: open.pr, head: open.head, dedupeKey: `pr:${open.pr}:${digest}`, payload })
}

export function prClosed(ts: string, closed: ClosedPr): BusEvent {
  const payload = { merged: closed.merged, ...(closed.commit === null ? {} : { commit: closed.commit }) }
  return observation(ts, 'pr.closed', { cardId: closed.cardId, pr: closed.pr, head: null, dedupeKey: `pr:${closed.pr}:closed`, payload })
}

export function mainAdvanced(ts: string, main: MainHead): BusEvent {
  return observation(ts, 'main.advanced', { cardId: null, pr: null, head: null, dedupeKey: `main:${main.sha}`, payload: { sha: main.sha, touches_mechanics: main.touchesMechanics } })
}

export function observationsOf(ts: string, snapshot: Snapshot): BusEvent[] {
  return [
    ...snapshot.open.map(open => prObserved(ts, open)),
    ...snapshot.closed.map(closed => prClosed(ts, closed)),
    ...(snapshot.main === null ? [] : [mainAdvanced(ts, snapshot.main)]),
  ]
}
