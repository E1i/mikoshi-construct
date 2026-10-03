export const MAX_RESTARTS = 3
export const CONTINUE_PROMPT = 'Прочитай handoff задачи целиком и продолжай с места остановки'
export const CONTINUE_MODES = ['auto', 'stop'] as const
export const QUESTION_LINE = /^question:/m

export type ContinueMode = typeof CONTINUE_MODES[number]
export type ExitReason = 'closed' | 'eddies-stop' | 'guard-refusal' | 'owner-question' | 'eddies-warn' | 'ended'

export interface SessionEvidence {
  exit: number | null
  closed: boolean
  stopped: boolean
  refused: boolean
  question: boolean
  warned: boolean
}

export const EXIT_REASON_TEXT: Record<ExitReason, string> = {
  'closed': 'task closed',
  'eddies-stop': 'eddies stop',
  'guard-refusal': 'guard refusal',
  'owner-question': 'question to the owner',
  'eddies-warn': 'eddies warn',
  'ended': 'ended on its own',
}

export function exitReason(evidence: SessionEvidence): ExitReason {
  if (evidence.closed)
    return 'closed'
  if (evidence.stopped)
    return 'eddies-stop'
  if (evidence.refused)
    return 'guard-refusal'
  if (evidence.question)
    return 'owner-question'
  if (evidence.warned && evidence.exit === 0)
    return 'eddies-warn'
  return 'ended'
}

export function continues(mode: ContinueMode, reason: ExitReason, restarts: number): boolean {
  return mode === 'auto' && reason === 'eddies-warn' && restarts < MAX_RESTARTS
}

interface EddiesEntry {
  event?: unknown
  hook?: unknown
  session_id?: unknown
}

function entriesOf(text: string): EddiesEntry[] {
  return text.split('\n').flatMap((line) => {
    try {
      const entry = JSON.parse(line) as EddiesEntry | null
      return entry !== null && typeof entry === 'object' ? [entry] : []
    }
    catch {
      return []
    }
  })
}

export function eddiesEvidence(journal: string, session: string): Pick<SessionEvidence, 'warned' | 'stopped' | 'refused'> {
  const own = entriesOf(journal).filter(entry => entry.session_id === session)
  return {
    warned: own.some(entry => entry.event === 'budget-warn'),
    stopped: own.some(entry => entry.event === 'budget-stop'),
    refused: own.some(entry => entry.event === 'unread' && entry.hook === 'eddies-guard'),
  }
}
