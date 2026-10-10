import type { RoleStop } from '../bus/role.js'
import process from 'node:process'
import { defaultBusPath, openBus } from '../bus/db.js'
import { observeRoleStop } from '../bus/role.js'

export interface RoleBus {
  busPath: string
  pid: number
  now: () => Date
  err: (line: string) => void
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
