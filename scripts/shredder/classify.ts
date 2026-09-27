import type { Unresolved } from './row.js'
import type { TaskRow } from './task.js'
import type { Capability } from './vocabulary.js'

export interface Classification {
  effort: string | null
  witnessCount: number
  klass: 'R2' | 'R1.5' | 'R1' | null
  executor: 'ladder' | 'direct'
  verification: Capability[]
  whyEntry: string
  unresolved: Unresolved | null
}

const DOC_EXTENSION = /\.md$/

function isDocPath(path: string): boolean {
  if (path.startsWith('tests/'))
    return true
  return DOC_EXTENSION.test(path) && !path.startsWith('.claude/') && !path.startsWith('templates/')
}

export function classify(task: TaskRow): Classification {
  const { effort, witnessCount } = task.build
  if (effort != null) {
    return {
      effort,
      witnessCount,
      klass: 'R2',
      executor: 'ladder',
      verification: ['need test report', 'need base replay', 'need mutation', 'need transcript inspection', 'need witness validation'],
      whyEntry: `K1 Effort: ${effort}`,
      unresolved: null,
    }
  }
  if (witnessCount > 0) {
    return {
      effort,
      witnessCount,
      klass: 'R1.5',
      executor: 'direct',
      verification: ['need test report', 'need base replay', 'need mutation', 'need witness validation'],
      whyEntry: `K2 witnesses: ${witnessCount}`,
      unresolved: null,
    }
  }
  const failing = task.write.filter(path => !isDocPath(path)).sort()
  if (failing.length === 0) {
    return {
      effort,
      witnessCount,
      klass: 'R1',
      executor: 'direct',
      verification: ['need test report'],
      whyEntry: `K3 docs: ${task.write.join(', ')}`,
      unresolved: null,
    }
  }
  return {
    effort,
    witnessCount,
    klass: null,
    executor: 'direct',
    verification: [],
    whyEntry: `K4 code: ${failing.join(', ')}`,
    unresolved: { level: 'REASONING_REQUIRED', reason: 'no Effort, no witness, writes code: R1 or R1.5', source: 'K4' },
  }
}
