import type { ChainObservation } from '../bus/chain.js'
import { execFileSync } from 'node:child_process'
import process from 'node:process'
import { observeChain } from '../bus/chain.js'
import { defaultBusPath, openBus } from '../bus/db.js'

export type ChainMoment = Omit<ChainObservation, 'sha' | 'pid'>

export interface ChainBus {
  busPath: string
  sha: () => string
  pid: number
  now: () => Date
  err: (line: string) => void
}

export function chainObserver(bus: ChainBus): (moment: ChainMoment) => void {
  let sha: string | undefined
  return (moment) => {
    try {
      sha ??= bus.sha()
      const db = openBus(bus.busPath)
      try {
        observeChain(db, bus.now().toISOString(), `worker:chain:${bus.pid}`, { ...moment, sha, pid: bus.pid })
      }
      finally {
        db.close()
      }
    }
    catch (error) {
      bus.err(`chain.observed not written to ${bus.busPath}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

export function realChainObserver(cwd: string, err: (line: string) => void): (moment: ChainMoment) => void {
  return chainObserver({
    busPath: defaultBusPath(),
    sha: () => execFileSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    pid: process.pid,
    now: () => new Date(),
    err,
  })
}
