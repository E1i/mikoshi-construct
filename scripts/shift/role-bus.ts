import type { DatabaseSync } from 'node:sqlite'
import type { RoleStop } from '../bus/role.js'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { defaultBusPath, openBus } from '../bus/db.js'
import { CHECK_MS } from '../bus/netwatch.js'
import { lastEventId, operatorWorkSince } from '../bus/operator-work.js'
import { observeRoleStop } from '../bus/role.js'

export interface RoleBus {
  busPath: string
  pid: number
  now: () => Date
  err: (line: string) => void
}

export interface OperatorWork {
  cursor: () => number
  wait: (cursor: number) => Promise<void>
}

export function roleStopObserver(bus: RoleBus): (stop: RoleStop) => void {
  return (stop) => {
    try {
      const db = openBus(bus.busPath)
      try {
        observeRoleStop(db, bus.now().toISOString(), `worker:${stop.role}:${bus.pid}`, stop)
      }
      finally {
        db.close()
      }
    }
    catch (error) {
      bus.err(`role.stopped not written to ${bus.busPath}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

export function realRoleStopObserver(err: (line: string) => void): (stop: RoleStop) => void {
  return roleStopObserver({ busPath: defaultBusPath(), pid: process.pid, now: () => new Date(), err })
}

export function operatorWork(busPath: string, pause: (ms: number) => Promise<unknown>): OperatorWork {
  const read = <T>(query: (db: DatabaseSync) => T): T => {
    const db = openBus(busPath)
    try {
      return query(db)
    }
    finally {
      db.close()
    }
  }
  return {
    cursor: () => read(lastEventId),
    wait: async (cursor) => {
      while (read(db => operatorWorkSince(db, cursor)) === null)
        await pause(CHECK_MS)
    },
  }
}

export function realOperatorWork(): OperatorWork {
  return operatorWork(defaultBusPath(), sleep)
}
