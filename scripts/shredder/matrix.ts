import type { OpenPr, OwnerMergeKind, PolicyRow, WindowRow } from './reader.js'
import type { Row } from './row.js'
import type { TaskRow } from './task.js'
import type { Capability } from './vocabulary.js'
import { markFreeWriters, notCheckedKinds, ownerMerges, releaseGate, releaseGateNumber } from './authority.js'
import { classify } from './classify.js'
import { sequenceTask, versionLockPr } from './sequence.js'
import { executorCapabilities, pathTriggeredCapabilities, sortByVocabulary } from './vocabulary.js'

function noPathsRow(task: TaskRow): Row {
  return {
    task: task.display,
    paths: { write: [], immutable: [] },
    effort: null,
    verification: [],
    class: null,
    why: [],
    contour: { after: [], parallelWith: [], worktree: null, locks: [], executor: null, merge: null, capabilities: [], notes: [] },
    unresolved: [{ level: 'REASONING_REQUIRED', reason: 'no paths', source: task.fileName }],
  }
}

export function buildRows(
  tasks: TaskRow[],
  windows: WindowRow[],
  policies: PolicyRow[],
  ownerMergeKinds: OwnerMergeKind[],
  openPrs: OpenPr[],
): { rows: Row[], notChecked: string[] } {
  const versionLock = versionLockPr(openPrs)
  const gateNumber = releaseGateNumber(policies)

  const rows: Row[] = tasks.map((task, index) => {
    if (task.noPaths)
      return noPathsRow(task)

    const sequencing = sequenceTask(index, tasks, openPrs, windows, versionLock)
    const classification = classify(task)
    const owner = ownerMerges(task.write, ownerMergeKinds)
    const gate = releaseGate(task.display, gateNumber)

    const verification = sortByVocabulary([...classification.verification, ...pathTriggeredCapabilities(task.write)])
    const capabilities = sortByVocabulary([...executorCapabilities(classification.executor), ...(owner.ownerMerged ? ['need human gate' as Capability] : [])])

    return {
      task: task.display,
      paths: { write: task.write, immutable: task.build.immutable },
      effort: classification.effort,
      verification,
      class: classification.klass,
      why: [...sequencing.why, classification.whyEntry, ...owner.why, ...gate.why],
      contour: {
        after: sequencing.after,
        parallelWith: sequencing.parallelWith,
        worktree: task.worktree,
        locks: sequencing.locks,
        executor: classification.executor,
        merge: owner.ownerMerged ? 'owner' : 'auto',
        capabilities,
        notes: gate.notes,
      },
      unresolved: [...(classification.unresolved ? [classification.unresolved] : []), ...owner.unresolved],
    }
  })

  const runnable = rows.filter((row, index) => !tasks[index]!.noPaths && row.contour.after.length === 0 && row.contour.locks.length === 0)
  markFreeWriters(runnable, windows)

  return { rows, notChecked: notCheckedKinds(ownerMergeKinds) }
}
