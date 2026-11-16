import type { DatabaseSync } from 'node:sqlite'
import type { ChildStart } from '../core/node.js'
import type { ProcessList, RunningProcess } from './bg.js'
import { appendEvent } from '../core/db.js'
import { SIGNAL_SENT } from '../core/events.js'
import { QUEUE_ACTOR } from '../core/queue.js'
import { childrenNotEnded } from './recorded-worker.js'

const STOP_WAIT_MS = 10_000
const STOP_POLL_MS = 100

export const RESTART_WHY = 'restart'

export type SignalSent = (pid: number, name: NodeJS.Signals) => void

export const NOTHING_RECORDED: SignalSent = () => {}

export interface SentSignal {
  child: ChildStart
  signal: NodeJS.Signals
  why: string
}

export function recordSignalSent(db: DatabaseSync, ts: string, sent: SentSignal): boolean {
  const { child, signal, why } = sent
  return appendEvent(db, { ts, type: SIGNAL_SENT, actor: QUEUE_ACTOR, cardId: null, pr: null, head: null, dedupeKey: `${SIGNAL_SENT}:${child.instance}:${child.pid}:${child.lstart}:${signal}`, payload: { pid: child.pid, lstart: child.lstart, signal, why, instance: child.instance, task_key: child.taskKey }, legacy: false })
}

export function childrenSignalledWith(db: DatabaseSync, group: number): ChildStart[] {
  return childrenNotEnded(db).filter(child => child.pgid === group || child.pid === group)
}

export function signalLog(db: DatabaseSync, why: string, clock: () => Date = () => new Date()): SignalSent {
  return (pid, name) => {
    try {
      for (const child of childrenSignalledWith(db, pid))
        recordSignalSent(db, clock().toISOString(), { child, signal: name, why })
    }
    catch {}
  }
}

export function recordedThenSent(recorded: SignalSent, send: SignalSent): SignalSent {
  return (pid, name) => {
    recorded(pid, name)
    send(pid, name)
  }
}

export async function stopSending(running: RunningProcess, processes: ProcessList, pause: (ms: number) => Promise<unknown>, send: SignalSent): Promise<void> {
  send(running.pid, 'SIGTERM')
  for (let waited = 0; waited < STOP_WAIT_MS; waited += STOP_POLL_MS) {
    if (!processes().some(candidate => candidate.pid === running.pid))
      return
    await pause(STOP_POLL_MS)
  }
  if (processes().some(candidate => candidate.pid === running.pid))
    send(running.pid, 'SIGKILL')
  await pause(STOP_POLL_MS)
}
