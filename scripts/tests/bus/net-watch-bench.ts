import type { DatabaseSync } from 'node:sqlite'
import type { GitHub } from '../../ports/github.js'
import { NetWatch } from '../../ports/netwatch.js'
import { RUN_SCRIPT } from '../../supervisor/bg.js'
import { requiredCheckAt } from '../../supervisor/composition.js'

export function benchNetWatch(db: DatabaseSync, gitHub: GitHub, clock: () => Date, process: string = RUN_SCRIPT): NetWatch {
  return new NetWatch(db, gitHub, clock, process, () => requiredCheckAt())
}
