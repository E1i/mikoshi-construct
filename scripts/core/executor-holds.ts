export const INLINE_QUEUES: ReadonlySet<string> = new Set(['update', 'merge', 'close'])

export const CARD_TREE_KINDS: ReadonlySet<string> = new Set(['answer', 'launch'])

export interface Handover {
  tasks: readonly string[]
  cards: readonly number[]
  prs: readonly number[]
}

export const NOTHING_HELD: Handover = { tasks: [], cards: [], prs: [] }

const IN_LIST = (list: Iterable<string>): string => [...list].map(each => `'${each}'`).join(', ')

export const HELD_BY_A_LIVE_EXECUTOR = `(tasks.task_key IN (SELECT value FROM json_each(?))
    OR (tasks.queue IN (${IN_LIST(CARD_TREE_KINDS)}) AND tasks.card_id IN (SELECT value FROM json_each(?)))
    OR (tasks.queue IN (${IN_LIST(INLINE_QUEUES)}) AND tasks.pr IN (SELECT value FROM json_each(?))))`

export function heldBindings(held: Handover): string[] {
  return [JSON.stringify(held.tasks), JSON.stringify(held.cards), JSON.stringify(held.prs)]
}
