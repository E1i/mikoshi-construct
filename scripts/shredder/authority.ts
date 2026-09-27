import type { OwnerMergeKind, PolicyRow, WindowRow } from './reader.js'
import type { Row, Unresolved } from './row.js'
import { matchGlob } from './glob.js'

export interface OwnerMerges {
  ownerMerged: boolean
  why: string[]
  unresolved: Unresolved[]
}

export interface ReleaseGate {
  why: string[]
  notes: string[]
}

export function notCheckedKinds(ownerMergeKinds: OwnerMergeKind[]): string[] {
  return ownerMergeKinds.filter(kind => kind.notChecked).map(kind => kind.kind)
}

export function ownerMerges(write: string[], ownerMergeKinds: OwnerMergeKind[]): OwnerMerges {
  const result: OwnerMerges = { ownerMerged: false, why: [], unresolved: [] }
  for (const kind of ownerMergeKinds) {
    if (kind.globs.length === 0)
      continue
    const matches = write.filter(path => kind.globs.some(glob => matchGlob(glob, path))).sort()
    if (matches.length === 0)
      continue
    result.why.push(`owner-merges ${kind.kind}: ${matches.join(', ')}`)
    result.ownerMerged = true
    result.unresolved.push({ level: 'DECISION_REQUIRED', reason: `owner merges (${kind.kind})`, source: 'owner-merges.md' })
  }
  return result
}

export function releaseGateNumber(policies: PolicyRow[]): string | null {
  const value = policies.find(policy => policy.policy === 'release-gate')?.value ?? null
  return value == null ? null : /#(\d+)/.exec(value)?.[1] ?? null
}

export function releaseGate(display: string, gateNumber: string | null): ReleaseGate {
  if (gateNumber == null || display !== `#${gateNumber}`)
    return { why: [], notes: [] }
  return { why: [`release-gate: ${display}`], notes: ['the release waits for it'] }
}

export function markFreeWriters(runnable: Row[], windows: WindowRow[]): void {
  const freeCount = windows.filter(row => row.state === 'free').length
  runnable.forEach((row, position) => {
    const rank = position + 1
    if (rank > freeCount) {
      row.why.push(`free-writers: ${freeCount} free, runnable ${rank}`)
      row.unresolved.push({ level: 'DECISION_REQUIRED', reason: 'open a window', source: 'open a window' })
    }
  })
}
