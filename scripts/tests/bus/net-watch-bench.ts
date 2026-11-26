import type { DatabaseSync } from 'node:sqlite'
import type { GitHub } from '../../ports/github.js'
import type { PrHistory } from '../../ports/netwatch.js'
import { NetWatch } from '../../ports/netwatch.js'
import { RUN_SCRIPT } from '../../supervisor/bg.js'
import { PR_HISTORY, requiredCheckAt } from '../../supervisor/composition.js'

export const NO_PR_HISTORY: PrHistory = { knownOpenPrs: () => [], lastMainSha: () => null, lastObservation: () => null }

export function benchNetWatch(db: DatabaseSync, gitHub: GitHub, clock: () => Date, process: string = RUN_SCRIPT): NetWatch {
  return new NetWatch(db, gitHub, clock, process, () => requiredCheckAt(), PR_HISTORY)
}
