import type { DatabaseSync } from 'node:sqlite'
import type { HeavyRun } from './identifiers.js'
import type { Lease } from './lease.js'
import { completeTask, expireLeases, leaseWhileFree, RENEW_MS, renewLease, StaleLease } from './lease.js'

export const SLOTS = { quality: 2, vitest: 2, review: 3 } as const
export type SlotKind = keyof typeof SLOTS
export const SLOTS_VARIABLE_PREFIX = 'CONSTRUCT_BUS_SLOTS_'
export const SLOT_POLL_MS = 5_000
export const PREFIX = '[bus:slot] '

const POSITIVE_DECIMAL = /^[1-9]\d*$/

export function slotsVariable(kind: SlotKind): string {
  return `${SLOTS_VARIABLE_PREFIX}${kind.toUpperCase()}`
}

export function slotsOf(kind: SlotKind, env: NodeJS.ProcessEnv): number {
  const variable = slotsVariable(kind)
  const given = env[variable]
  if (given === undefined || given === '')
    return SLOTS[kind]
  if (!POSITIVE_DECIMAL.test(given))
    throw new Error(`${variable} is not a positive integer: ${given}`)
  return Number(given)
}

export interface HeavyRunParts {
  db: DatabaseSync
  clock: () => Date
  session: string
  slots: number
  pause: (ms: number) => Promise<unknown>
  announce: (line: string) => void
}

export interface HeavyRunCall {
  kind: HeavyRun
  cardId: number
  command: () => Promise<number>
}

export class SlotScheduler {
  readonly actor: string

  constructor(private readonly parts: HeavyRunParts) {
    this.actor = `worker:slot:${parts.session}`
  }

  private ts(): string {
    return this.parts.clock().toISOString()
  }

  tryTake(kind: HeavyRun, cardId: number): Lease | null {
    const { db, session, slots } = this.parts
    expireLeases(db, this.ts())
    return leaseWhileFree(db, this.ts(), { queue: kind, cardId, generation: session }, this.actor, slots)
  }

  async take(kind: HeavyRun, cardId: number): Promise<Lease> {
    let announced = false
    for (;;) {
      const lease = this.tryTake(kind, cardId)
      if (lease !== null)
        return lease
      if (!announced)
        this.parts.announce(`${PREFIX}every ${kind} slot (${this.parts.slots}) is leased; waiting for one`)
      announced = true
      await this.parts.pause(SLOT_POLL_MS)
    }
  }

  release(lease: Lease): void {
    try {
      completeTask(this.parts.db, this.ts(), lease, [])
    }
    catch (error) {
      if (!(error instanceof StaleLease))
        throw error
      this.parts.announce(`${PREFIX}${lease.taskKey}: the lease lapsed while the command ran; the slot was already given back`)
    }
  }

  async run(call: HeavyRunCall): Promise<number> {
    const lease = await this.take(call.kind, call.cardId)
    const heartbeat = setInterval(() => {
      try {
        renewLease(this.parts.db, this.ts(), lease)
      }
      catch (error) {
        if (error instanceof StaleLease)
          clearInterval(heartbeat)
        else
          this.parts.announce(`${PREFIX}${lease.taskKey}: the lease was not renewed this beat, the heartbeat keeps running: ${error instanceof Error ? error.message : String(error)}`)
      }
    }, RENEW_MS)
    try {
      return await call.command()
    }
    finally {
      clearInterval(heartbeat)
      this.release(lease)
    }
  }
}
