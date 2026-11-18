import type { DatabaseSync } from 'node:sqlite'
import type { CardTransitions, HolderReading } from '../core/lease.js'
import type { DetachedLaunch } from './bg.js'
import { CHILD_ENDED, SIGNAL_SENT, TASK_EXPIRED, TASK_RENEWED } from '../core/events.js'
import { expireLeasesHeldBy, leasesHeldBy, RESTART_CUT, SUPERVISOR_RENEWS } from '../core/lease.js'
import { PREFIX } from './bg.js'
import { holderLines } from './generation-handover.js'
import { SILENT_MS } from './liveness-sites.js'
import { isBusWorker } from './workers.js'

export function workerKindsOf(launches: DetachedLaunch[]): string[] {
  return launches.map(launch => launch.script.replace(/^bus:/, '')).filter(isBusWorker)
}

export function freeLeasesOf(db: DatabaseSync, cards: CardTransitions, ts: string, stopped: DetachedLaunch[]): string[] {
  const kinds = workerKindsOf(stopped)
  const held = leasesHeldBy(db, kinds)
  const freed = expireLeasesHeldBy(db, cards, ts, kinds, SILENT_MS)
  const kept = held.filter(key => !freed.includes(key))
  return [
    ...freed.length === 0 ? [] : [`${PREFIX}freed the leases of the stopped workers at once as ${TASK_EXPIRED}: ${freed.join(', ')}`],
    ...kept.length === 0 ? [] : [`${PREFIX}these leases of the stopped workers have a registered executor and follow it: the supervisor renews them while it is proven alive and returns them only once its end is proven: ${kept.join(', ')}`],
  ]
}

export function judgedLeaseLines(reading: HolderReading): string[] {
  const renewed = reading.renewed ?? []
  const returned = reading.returned ?? []
  return [
    ...holderLines(reading),
    ...renewed.length === 0 ? [] : [`${PREFIX}the worker that held these leases has ended and their registered executor runs on; the supervisor renews them as ${TASK_RENEWED} under ${SUPERVISOR_RENEWS}<executor pid>: ${renewed.join(', ')}`],
    ...returned.length === 0 ? [] : [`${PREFIX}the executor of these leases ended after a ${SIGNAL_SENT}; its ${CHILD_ENDED} with that signal is recorded and the task is returned as ${RESTART_CUT}: ${returned.join(', ')}`],
  ]
}
