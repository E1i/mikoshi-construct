import type { DatabaseSync } from 'node:sqlite'
import { allowLiveCommand, namesQueueLive } from '../live-decision.js'
import { waitsTheDecisionNames } from './index.js'

export interface DecisionAnswer {
  answer: string
  scope: string
  commands: string[]
  named: string[]
}

const QUEUE_NAME = /^[\w-]+$/

function commandsTheDecisionAnswers(text: string): string[] {
  const queue = text.trim().split(/\s+/).at(-1) ?? ''
  return QUEUE_NAME.test(queue) && namesQueueLive(text, queue) ? [allowLiveCommand(queue)] : []
}

export function answersOfTheDecisions(db: DatabaseSync, eventId: number): DecisionAnswer[] {
  const decisions = db.prepare('SELECT decision_id, text, scope FROM decisions WHERE event_id = ?').all(eventId) as { decision_id: number, text: string, scope: string | null }[]
  return decisions.map(decision => ({
    answer: `D-${decision.decision_id}`,
    scope: decision.scope ?? '[]',
    commands: commandsTheDecisionAnswers(decision.text),
    named: waitsTheDecisionNames(db, decision.text),
  }))
}
