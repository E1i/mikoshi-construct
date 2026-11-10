export const LAW_NODES = ['answer', 'close', 'launch', 'merge', 'restart', 'review', 'update', 'witness'] as const

export type LawNode = typeof LAW_NODES[number]

export const LAWS = {
  Z1: 'a process that leaves does not kill its children',
  Z2: 'an infrastructure failure (a timeout under load, an abandoned CI run, a usage limit, a failed measurement) is a retry, not a defect and not a question for the owner',
  Z3: 'decisions of the window under a shard act the same in every node',
  Z4: 'every "waits" has a wait record and the one who lifts it',
  Z5: 'every launch writes its own event',
  Z6: 'a dirty tree has a way back',
  Z7: 'liveness is read from more than one signal',
} as const

export type LawId = keyof typeof LAWS

export type LawCell
  = | { witness: string }
    | { notApplicable: string }
    | { gap: readonly number[] }

export type LawCells = Readonly<Record<LawId, Readonly<Record<LawNode, LawCell>>>>

export interface GapRow {
  law: LawId
  node: LawNode
  cards: readonly number[]
}

const NO_IN_MEMORY_PORT = 1672
export const RESTART_KEEPS_SESSION = 'Z1-restart-keeps-session'
const STARTS_NO_SESSION = 'the node starts no session, so no child process of its own outlives it'

function gap(...cards: number[]): LawCell {
  return { gap: cards }
}

function everyNode(cell: LawCell): Record<LawNode, LawCell> {
  return Object.fromEntries(LAW_NODES.map(node => [node, cell])) as Record<LawNode, LawCell>
}

export const LAW_CELLS: LawCells = {
  Z1: {
    answer: { witness: RESTART_KEEPS_SESSION },
    close: { notApplicable: STARTS_NO_SESSION },
    launch: { witness: RESTART_KEEPS_SESSION },
    merge: { notApplicable: STARTS_NO_SESSION },
    restart: { notApplicable: STARTS_NO_SESSION },
    review: { witness: RESTART_KEEPS_SESSION },
    update: { notApplicable: STARTS_NO_SESSION },
    witness: { witness: RESTART_KEEPS_SESSION },
  },
  Z2: everyNode(gap(1774)),
  Z3: { ...everyNode(gap(NO_IN_MEMORY_PORT)), answer: gap(1775) },
  Z4: everyNode(gap(1740, 1754)),
  Z5: everyNode(gap(1767)),
  Z6: everyNode(gap(1764)),
  Z7: everyNode(gap(1756)),
}

export function lawIds(): LawId[] {
  return Object.keys(LAWS) as LawId[]
}

export function gapRows(cells: LawCells = LAW_CELLS): GapRow[] {
  return lawIds().flatMap(law => LAW_NODES.flatMap((node) => {
    const cell = cells[law][node]
    return 'gap' in cell ? [{ law, node, cards: cell.gap }] : []
  }))
}
