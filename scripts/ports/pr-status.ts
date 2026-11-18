import { realpathSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { defaultBusPath, openBus } from '../core/db.js'
import { setStepStatuses, statusLine } from '../core/pr-status.js'
import { ghApiPost } from './github.js'

export const TECHNOLOGY_WORDS = ['database'] as const

function main(): number {
  const db = openBus(defaultBusPath())
  try {
    for (const status of setStepStatuses(db, ghApiPost(process.cwd())))
      console.log(statusLine(status))
    return 0
  }
  finally {
    db.close()
  }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = main()
