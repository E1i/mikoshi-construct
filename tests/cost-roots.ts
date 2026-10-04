import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { WINDOW_JOURNAL_FILE } from '../src/commands/cost/index.js'

export function isolatedCostRoots(): { projectsDir: string, shiftRoot: string, windowJournal: string } {
  const home = mkdtempSync(path.join(tmpdir(), 'construct-cost-roots-'))
  return { projectsDir: path.join(home, 'projects'), shiftRoot: path.join(home, 'shift'), windowJournal: path.join(home, 'handoff', WINDOW_JOURNAL_FILE) }
}
