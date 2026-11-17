import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { isMainThread, parentPort, workerData } from 'node:worker_threads'
import { openBus } from '../core/db.js'
import { REDUCER_LOOP_BUS_PATH, REDUCER_LOOP_HOME, REDUCER_LOOP_PERIOD, REDUCER_PASS_DONE, ReducerLoop } from './reducer-loop.js'
import { composeReducerPass } from './run.js'

export async function runReducerLoop(busPath: string, home: string, periodMs: number, running: () => boolean = () => true, log: (line: string) => void = console.log, passed: () => void = () => parentPort?.postMessage(REDUCER_PASS_DONE)): Promise<void> {
  const db = openBus(busPath)
  try {
    const loop = new ReducerLoop(composeReducerPass(db, busPath, () => new Date(), home, process.cwd(), process.env, log), periodMs)
    while (running()) {
      const lines = loop.step()
      if (lines.length > 0)
        log(lines.join('\n'))
      passed()
      await sleep(periodMs)
    }
  }
  finally {
    db.close()
  }
}

const started = workerData as Record<string, unknown> | null
if (!isMainThread && typeof started?.[REDUCER_LOOP_BUS_PATH] === 'string' && typeof started[REDUCER_LOOP_HOME] === 'string')
  await runReducerLoop(started[REDUCER_LOOP_BUS_PATH], started[REDUCER_LOOP_HOME], Number(started[REDUCER_LOOP_PERIOD]))
