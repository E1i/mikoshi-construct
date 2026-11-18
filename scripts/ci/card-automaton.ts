export interface CardCondition {
  state: string
  condition: string
}

export interface CardMover {
  node: string
  selects: readonly CardCondition[]
}

export interface CardAutomaton {
  states: readonly string[]
  ends: readonly string[]
  conditions: readonly CardCondition[]
}

export interface UnmovedCondition extends CardCondition {
  why: string
}

export function conditionKey(condition: CardCondition): string {
  return `${condition.state}/${condition.condition}`
}

function inWork(automaton: CardAutomaton): string[] {
  return automaton.states.filter(state => !automaton.ends.includes(state))
}

export function statesWithNoCondition(automaton: CardAutomaton): string[] {
  return inWork(automaton).filter(state => !automaton.conditions.some(condition => condition.state === state))
}

export function moversOf(movers: readonly CardMover[], state: string, condition: string | null = null): string[] {
  const selects = (selected: CardCondition): boolean => selected.state === state && (condition === null || selected.condition === condition)
  return [...new Set(movers.filter(mover => mover.selects.some(selects)).map(mover => mover.node))]
}

export function unmovedConditions(automaton: CardAutomaton, movers: readonly CardMover[]): UnmovedCondition[] {
  const selected = new Set(movers.flatMap(mover => mover.selects.map(conditionKey)))
  return automaton.conditions
    .filter(condition => !automaton.ends.includes(condition.state) && !selected.has(conditionKey(condition)))
    .map(condition => ({ ...condition, why: `no node's queue candidates select a ${condition.state} card on ${condition.condition}` }))
}

export function strayMoves(automaton: CardAutomaton, movers: readonly CardMover[]): string[] {
  const known = new Set(automaton.conditions.map(conditionKey))
  return movers.flatMap(mover => mover.selects.filter(selected => !known.has(conditionKey(selected))).map(selected => `${mover.node} selects ${conditionKey(selected)}, which is no condition of the card automaton`))
}

export function automatonFindings(automaton: CardAutomaton, movers: readonly CardMover[]): string[] {
  return [
    ...statesWithNoCondition(automaton).map(state => `card state ${state} is reachable and names no condition, so no node can be shown to select it`),
    ...unmovedConditions(automaton, movers).map(unmoved => `dead end ${conditionKey(unmoved)}: ${unmoved.why}`),
    ...strayMoves(automaton, movers),
  ]
}
