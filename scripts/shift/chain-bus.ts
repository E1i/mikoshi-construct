import type { ChainObservation } from '../bus/chain.js'
import type { BusMerge } from './merge.js'
import { execFileSync } from 'node:child_process'
import process from 'node:process'
import { observeChain } from '../bus/chain.js'
import { defaultBusPath, openBus } from '../bus/db.js'
import { MERGE_DONE } from '../bus/executor.js'
import { busMerge } from './merge.js'

export type ChainMoment = Omit<ChainObservation, 'sha' | 'pid' | 'leader'>

export interface ChainBus {
  busPath: string
  sha: () => string
  pid: number
  leader: () => number | null
  now: () => Date
  err: (line: string) => void
}

export function chainObserver(bus: ChainBus): (moment: ChainMoment) => void {
  let sha: string | undefined
  let leader: number | null | undefined
  return (moment) => {
    try {
      sha ??= bus.sha()
      leader ??= bus.leader()
      const db = openBus(bus.busPath)
      try {
        observeChain(db, bus.now().toISOString(), `worker:chain:${bus.pid}`, { ...moment, sha, pid: bus.pid, leader })
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

export function chainBusMerge(busPath: string, err: (line: string) => void): (pr: number, head: string) => BusMerge {
  return (pr, head) => {
    try {
      const db = openBus(busPath)
      try {
        return busMerge(db, pr, head)
      }
      finally {
        db.close()
      }
    }
    catch (error) {
      err(`${MERGE_DONE} of PR #${pr} not read from ${busPath}: ${error instanceof Error ? error.message : String(error)}`)
      return { kind: 'waiting' }
    }
  }
}

export function processGroupOf(pid: number): number | null {
  try {
    const group = Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim())
    return Number.isSafeInteger(group) && group > 0 ? group : null
  }
  catch {
    return null
  }
}

export function realChainObserver(cwd: string, err: (line: string) => void): (moment: ChainMoment) => void {
  return chainObserver({
    busPath: defaultBusPath(),
    sha: () => execFileSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    pid: process.pid,
    leader: () => processGroupOf(process.pid),
    now: () => new Date(),
    err,
  })
}
