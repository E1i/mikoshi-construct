import { realpathSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { runInbox } from '../core/inbox.js'
import { openComposedBus } from '../supervisor/composition.js'

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const db = openComposedBus()
  try {
    process.exitCode = runInbox(db, line => console.log(line))
  }
  finally {
    db.close()
  }
}
