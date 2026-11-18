import type { DatabaseSync } from 'node:sqlite'

export interface CardCondition {
  state: string
  condition: string
}

export interface CardAutomaton {
  states: readonly string[]
  ends: readonly string[]
  conditions: readonly CardCondition[]
}

export type CardsSelected = (db: DatabaseSync, ts: string) => readonly (number | null)[]

export interface NodeCandidates {
  node: string
  selects: CardsSelected
}

export interface ConditionSelection extends CardCondition {
  nodes: readonly string[]
}

export function conditionKey(condition: CardCondition): string {
  return `${condition.state}/${condition.condition}`
}

export function selectingNodes(db: DatabaseSync, ts: string, candidates: readonly NodeCandidates[], card: number): string[] {
  return [...new Set(candidates.filter(node => node.selects(db, ts).includes(card)).map(node => node.node))]
}

function inWork(automaton: CardAutomaton): string[] {
  return automaton.states.filter(state => !automaton.ends.includes(state))
}

export function statesWithNoCondition(automaton: CardAutomaton): string[] {
  return inWork(automaton).filter(state => !automaton.conditions.some(condition => condition.state === state))
}

export function automatonFindings(automaton: CardAutomaton, selections: readonly ConditionSelection[]): string[] {
  const selected = new Map(selections.map(selection => [conditionKey(selection), selection.nodes]))
  const inWorkConditions = automaton.conditions.filter(condition => !automaton.ends.includes(condition.state))
  return [
    ...statesWithNoCondition(automaton).map(state => `card state ${state} is reachable and names no condition, so no node can be shown to select it`),
    ...inWorkConditions.filter(condition => !selected.has(conditionKey(condition))).map(condition => `card condition ${conditionKey(condition)} was not placed on a bus, so no node's candidates were asked`),
    ...inWorkConditions.filter(condition => selected.get(conditionKey(condition))?.length === 0).map(condition => `dead end ${conditionKey(condition)}: no node's queue candidates select a ${condition.state} card on ${condition.condition}`),
  ]
}

export function automatonOf(states: readonly string[], ends: readonly string[], conditions: readonly CardCondition[]): CardAutomaton {
  return { states, ends, conditions }
}
