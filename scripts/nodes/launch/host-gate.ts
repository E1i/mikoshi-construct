import type { DatabaseSync } from 'node:sqlite'
import type { MachineSessions } from '../../core/machine-sessions.js'
import type { HostThermal } from '../../ports/host-thermal.js'
import type { MachineReader } from './launch-candidates.js'
import type { CardStarter } from './launch-executor.js'
import { appendEvent } from '../../core/db.js'
import { BOARD_ALARM } from '../../core/events.js'
import { MACHINE_POLL_MS, machineHoldLine } from '../../core/machine-sessions.js'
import { HOST_DEGRADED, hostDegradedLine, hostFaultInText, hostFaultOf, HostFaultPersists } from '../../ports/host-fault.js'
import { HOST_HOT, hostHotLine, thermalFree, UNREAD_THERMAL } from '../../ports/host-thermal.js'

export const HOST_FAULT_RETRY_MS = MACHINE_POLL_MS

const HOUR_OF_TS = 13

export interface LaunchHost {
  lanes: () => number
  machine: MachineReader
  thermal: HostThermal
}

export function hostFaultAware(starter: CardStarter): CardStarter {
  return {
    get identify() {
      return starter.identify?.bind(starter)
    },
    start: (card, ended) => {
      const start = starter.start(card, ended)
      const fault = start.kind === 'refused' && start.denial.reason === 'start_failed' ? hostFaultInText(start.denial.detail) : null
      if (fault !== null)
        throw new HostFaultPersists(fault, 1)
      return start
    },
    stop: card => starter.stop(card),
  }
}

export class HostGate {
  constructor(private readonly db: DatabaseSync, private readonly machine: MachineSessions, private readonly actor: string, private readonly ts: () => string, private readonly thermal: HostThermal = UNREAD_THERMAL) {}

  blocks(): boolean {
    return this.machine.overload() !== null || this.thermal.level() === 'heavy'
  }

  held(): string | null {
    const load = this.machine.overload()
    if (load !== null)
      return machineHoldLine({ live: this.machine.live(), limit: this.machine.limit(), load })
    const level = this.thermal.level()
    if (level !== 'heavy')
      return null
    const line = hostHotLine(level)
    this.alarm(HOST_HOT, 'thermal', line)
    return line
  }

  waitLine(): string | null {
    const held = this.held()
    if (held !== null)
      return held
    const level = this.thermal.level()
    const free = this.machine.free()
    return thermalFree(free, level) > 0 || level !== 'moderate' ? null : `thermal pressure ${level} halves the ${free} free session slots of the machine to none; the start waits until a slot frees or the level falls back`
  }

  degraded(cardId: number, error: unknown): typeof HOST_DEGRADED | null {
    const fault = hostFaultOf(error)
    if (fault === null)
      return null
    this.alarm(HOST_DEGRADED, fault.source, hostDegradedLine(`card #${cardId} could not start: ${fault.detail}`))
    return HOST_DEGRADED
  }

  launchHost(lanes: () => number): LaunchHost {
    return { lanes, machine: this.machine, thermal: this.thermal }
  }

  private alarm(reason: string, cause: string, detail: string): void {
    const ts = this.ts()
    appendEvent(this.db, { ts, type: BOARD_ALARM, actor: this.actor, cardId: null, pr: null, head: null, dedupeKey: `${BOARD_ALARM}:${reason}:${ts.slice(0, HOUR_OF_TS)}`, payload: { reason, cause, detail }, legacy: false })
  }
}
