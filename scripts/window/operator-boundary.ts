export const OPERATOR_CONTEXT_THRESHOLD = 180_000

export type BoundaryMove = 'end' | 'next'

interface Usage {
  input_tokens?: unknown
  cache_creation_input_tokens?: unknown
  cache_read_input_tokens?: unknown
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

function contextOfLine(line: string): number | null {
  try {
    const entry = JSON.parse(line) as { message?: { role?: unknown, usage?: Usage | null } } | null
    const usage = entry?.message?.role === 'assistant' ? entry.message.usage : null
    if (usage == null || typeof usage !== 'object')
      return null
    return count(usage.input_tokens) + count(usage.cache_creation_input_tokens) + count(usage.cache_read_input_tokens)
  }
  catch {
    return null
  }
}

export function transcriptContext(text: string): number | null {
  return text.split('\n').map(contextOfLine).filter(context => context !== null).at(-1) ?? null
}

const END_ACTION = 'write STOP with STATUS: CONTINUE through pnpm handoff:write and exit, so relaunch starts the next session from the handoff'

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
