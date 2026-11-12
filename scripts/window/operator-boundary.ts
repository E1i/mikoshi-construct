import { HANDOFF_WRITE_COMMAND } from '../core/owner-commands.js'

export const OPERATOR_CONTEXT_THRESHOLD = 180_000

export type BoundaryMove = 'end' | 'next'

const END_ACTION = `write STOP with STATUS: CONTINUE through ${HANDOFF_WRITE_COMMAND} and exit, so relaunch starts the next session from the handoff`

export function boundaryMove(context: number | null): BoundaryMove {
  return context === null || context >= OPERATOR_CONTEXT_THRESHOLD ? 'end' : 'next'
}

export function boundaryLine(context: number | null, transcript: string): string {
  if (context === null)
    return `end: context unread in ${transcript}; ${END_ACTION}`
  return boundaryMove(context) === 'end'
    ? `end: context ${context} ≥ ${OPERATOR_CONTEXT_THRESHOLD}; ${END_ACTION}`
    : `next: context ${context} < ${OPERATOR_CONTEXT_THRESHOLD}; take the next task`
}
