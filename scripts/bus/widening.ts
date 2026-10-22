import { ownerPathsOf } from '../../src/commands/intake/check.js'

export function ownerGlobs(ownerMergesText: string): string[] {
  const owner = ownerPathsOf(ownerMergesText)
  return [...owner.globs, ...owner.byRisk.flatMap(row => row.globs)]
}
