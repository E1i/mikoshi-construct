import type { WindowEnd } from '../nodes/restart/role.js'
import { openBus } from '../core/db.js'
import { returnEndedRole } from '../nodes/restart/role.js'

export interface WindowBus {
  busPath: string
  pid: number
  now: () => Date
  err: (line: string) => void
}

export function windowEndObserver(bus: WindowBus): (end: WindowEnd) => void {
  return (end) => {
    try {
      const db = openBus(bus.busPath)
      try {
        const returned = returnEndedRole(db, bus.now().toISOString(), `worker:miko:${bus.pid}`, 'miko', end)
        if (returned !== null)
          bus.err(`the window ended by ${end}: role ${returned.role} returned to the bus`)
      }
      finally {
        db.close()
      }
    }
    catch (error) {
      bus.err(`role.returned not written to ${bus.busPath}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
