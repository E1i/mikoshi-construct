import type { HeavyRun } from './identifiers.js'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { constants } from 'node:os'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { defaultBusPath, openBus } from './db.js'
import { cardIdOf, HEAVY_RUNS } from './identifiers.js'
import { PREFIX, SlotScheduler, slotsOf } from './scheduler.js'

export const CARD_FLAG = '--card'
const SEPARATOR = '--'
const USAGE = `pnpm bus:slot <${HEAVY_RUNS.join(' | ')}> ${CARD_FLAG} <card> -- <command>`
const SIGNALLED = 128

export type SlotCall
  = | { kind: 'run', run: HeavyRun, cardId: number, command: string[] }
    | { kind: 'refused', reason: string }

function isHeavyRun(value: string | undefined): value is HeavyRun {
  return (HEAVY_RUNS as readonly (string | undefined)[]).includes(value)
}

export function slotCall(argv: string[]): SlotCall {
  const [run, ...rest] = argv
  if (!isHeavyRun(run))
    return { kind: 'refused', reason: `the kind is one of ${HEAVY_RUNS.join(' | ')}: ${USAGE}` }
  const separator = rest.indexOf(SEPARATOR)
  const options = separator === -1 ? rest.slice(0, 2) : rest.slice(0, separator)
  const command = separator === -1 ? rest.slice(2) : rest.slice(separator + 1)
  const cardId = options.length === 2 && options[0] === CARD_FLAG ? cardIdOf(options[1]) : null
  if (cardId === null)
    return { kind: 'refused', reason: `a heavy run is accounted to a card: ${USAGE}` }
  if (command.length === 0)
    return { kind: 'refused', reason: `no command to run: ${USAGE}` }
  return { kind: 'run', run, cardId, command }
}

export async function spawnInherited(command: string[]): Promise<number> {
  const [file, ...args] = command
  return new Promise((resolve) => {
    const child = spawn(file!, args, { stdio: 'inherit' })
    child.on('error', (error) => {
      console.error(`${PREFIX}${file} did not start: ${error.message}`)
      resolve(1)
    })
    child.on('close', (code, signal) => resolve(code ?? SIGNALLED + (signal === null ? 0 : constants.signals[signal])))
  })
}

export interface SlotRun {
  busPath: string
  session: string
  env: NodeJS.ProcessEnv
  clock: () => Date
  pause: (ms: number) => Promise<unknown>
  spawn: (command: string[]) => Promise<number>
}

export async function runSlot(argv: string[], run: SlotRun): Promise<number> {
  const call = slotCall(argv)
  if (call.kind === 'refused') {
    console.error(`${PREFIX}${call.reason}`)
    return 1
  }
  const db = openBus(run.busPath)
  try {
    const scheduler = new SlotScheduler({ db, clock: run.clock, session: run.session, slots: slotsOf(call.run, run.env), pause: run.pause, announce: line => console.error(line) })
    return await scheduler.run({ kind: call.run, cardId: call.cardId, command: async () => run.spawn(call.command) })
  }
  finally {
    db.close()
  }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runSlot(process.argv.slice(2), {
    busPath: defaultBusPath(),
    session: randomUUID(),
    env: process.env,
    clock: () => new Date(),
    pause: sleep,
    spawn: spawnInherited,
  })
}
