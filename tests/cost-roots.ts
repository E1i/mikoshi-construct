import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

export function isolatedCostRoots(): { projectsDir: string, shiftRoot: string, busPath: string } {
  const home = mkdtempSync(path.join(tmpdir(), 'construct-cost-roots-'))
  return { projectsDir: path.join(home, 'projects'), shiftRoot: path.join(home, 'shift'), busPath: path.join(home, 'bus.db') }
}
