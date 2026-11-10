import { FACTORY_WORKERS } from '../core/factory-paths.js'

export const LAW_NODES = ['answer', 'close', 'launch', 'merge', 'restart', 'review', 'update', 'witness'] as const

export type LawNode = typeof LAW_NODES[number]

export const SITES_BEYOND_NODES = {
  netwatch: 'scripts/ports/netwatch.ts',
  window: 'scripts/window/watch.ts',
  intake: 'src/commands/intake/admit.ts',
  supervisor: 'scripts/supervisor/stalled-sessions.ts',
} as const

export type SiteBeyondNodes = keyof typeof SITES_BEYOND_NODES

export type LawSite = LawNode | SiteBeyondNodes

export const LAW_SITES: readonly LawSite[] = [...LAW_NODES, ...Object.keys(SITES_BEYOND_NODES) as SiteBeyondNodes[]]

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

export type LawCells = Readonly<Record<LawId, Readonly<Record<LawSite, LawCell>>>>

export interface GapRow {
  law: LawId
  node: LawSite
  cards: readonly number[]
}

const NO_IN_MEMORY_PORT = 1672
export const NODE_CONTRACT_SUITE = 1777
const WAIT_RECORDS = [1740, 1754]
const LAUNCH_EVENTS = 1767
const TREE_WAY_BACK = 1764
const INTAKE_READS_DECISIONS = 1779
export const SLICED_DROP_REPOINTS_DEPENDS = 1789
export const REVIEW_STALL_IS_NOT_A_SILENT_LOOP = 1792
export const CARD_WAIT_STATES = 1740
export const NO_HEAD_OF_LINE = 1744
export const RESTART_KEEPS_SESSION = 'Z1-restart-keeps-session'
export const SESSION_BEAT_BESIDE_STALE_WINDOW = 'Z7-session-beat-beside-stale-window'
export const PULSE_BESIDE_CARD_SILENCE = 'Z7-pulse-beside-card-silence'
export const WINDOW_BESIDE_SESSIONS = 'Z7-window-beside-sessions'
export const INFRASTRUCTURE_RETRIED = 'Z2-infrastructure-retried'
export const ABANDONED_READ_AS_RERUN = 'Z2-abandoned-read-as-rerun'
export const DIRECT_IMPORTER_WIDENED = 'Z3-direct-importer-widened'
const NO_INFRASTRUCTURE_TO_FAIL = 'the node starts no session, runs no test and judges no CI run, so no timeout under load, abandoned run or usage limit reaches it as its own failure'
const STARTS_NO_SESSION = 'the node starts no session, so no child process of its own outlives it'
const NO_SESSION_TO_READ = 'the node starts no session, so the factory reading holds no beat of its own to weigh'

function gap(...cards: number[]): LawCell {
  return { gap: cards }
}

function everyNode(cell: LawCell): Record<LawNode, LawCell> {
  return Object.fromEntries(LAW_NODES.map(node => [node, cell])) as Record<LawNode, LawCell>
}

const NETWATCH: Record<LawId, LawCell> = {
  Z1: { notApplicable: 'netwatch starts no session; its GitHub calls are synchronous and end inside the tick, so no child of its own outlives it' },
  Z2: { witness: ABANDONED_READ_AS_RERUN },
  Z3: { notApplicable: 'netwatch records what GitHub shows as bus events and takes no decision a window decision governs' },
  Z4: { notApplicable: 'netwatch opens no wait: a retry-after is a netwatch.skipped event carrying its until, and the clock lifts it' },
  Z5: { notApplicable: 'netwatch launches nothing' },
  Z6: { notApplicable: 'netwatch writes no tree, only bus events and its heartbeat' },
  Z7: gap(NODE_CONTRACT_SUITE),
}

const WINDOW: Record<LawId, LawCell> = {
  Z1: { notApplicable: 'miko:watch starts no session and no child process; it reads the bus and writes its own cursor' },
  Z2: gap(NODE_CONTRACT_SUITE),
  Z3: { notApplicable: 'the window is where these decisions are taken; the law is about the nodes that act on them' },
  Z4: gap(...WAIT_RECORDS),
  Z5: { notApplicable: 'miko:watch launches nothing; a card the window starts is launched by the launch node, which writes the event' },
  Z6: { notApplicable: 'miko:watch writes no card tree, only its cursor beside the handoff' },
  Z7: { witness: WINDOW_BESIDE_SESSIONS },
}

const INTAKE: Record<LawId, LawCell> = {
  Z1: { notApplicable: 'intake starts no session and no child process' },
  Z2: { notApplicable: 'intake admits from the card text and the bus; it starts no session, runs no test and reads no CI run' },
  Z3: gap(INTAKE_READS_DECISIONS),
  Z4: gap(...WAIT_RECORDS, SLICED_DROP_REPOINTS_DEPENDS),
  Z5: { notApplicable: 'intake launches nothing; it admits a card the launch node later starts' },
  Z6: { notApplicable: 'intake writes the parking lane and the bus, never a card tree' },
  Z7: { notApplicable: 'intake reads no liveness: it admits from the card text, the decisions in force and the bus card states' },
}

const SUPERVISOR: Record<LawId, LawCell> = {
  Z1: { notApplicable: 'StalledSessions starts no process; a session it ends it ends by name, which Z7 judges, not a child left behind' },
  Z2: gap(NODE_CONTRACT_SUITE),
  Z3: { notApplicable: 'StalledSessions applies the stall lines it is built with and takes no decision a window decision governs' },
  Z4: { notApplicable: 'StalledSessions opens no wait: it raises session.stalled, queues a dead session\'s task again or ends a review session' },
  Z5: { notApplicable: 'StalledSessions launches nothing' },
  Z6: { notApplicable: 'StalledSessions writes bus events and task releases, never a card tree' },
  Z7: gap(REVIEW_STALL_IS_NOT_A_SILENT_LOOP),
}

function beyondNodes(law: LawId): Record<SiteBeyondNodes, LawCell> {
  return { netwatch: NETWATCH[law], window: WINDOW[law], intake: INTAKE[law], supervisor: SUPERVISOR[law] }
}

export const LAW_CELLS: LawCells = {
  Z1: {
    answer: gap(NODE_CONTRACT_SUITE),
    close: { notApplicable: STARTS_NO_SESSION },
    launch: gap(NODE_CONTRACT_SUITE),
    merge: { notApplicable: STARTS_NO_SESSION },
    restart: { notApplicable: STARTS_NO_SESSION },
    review: gap(NODE_CONTRACT_SUITE),
    update: { notApplicable: STARTS_NO_SESSION },
    witness: gap(NODE_CONTRACT_SUITE),
    ...beyondNodes('Z1'),
  },
  Z2: {
    answer: gap(NODE_CONTRACT_SUITE),
    close: { notApplicable: NO_INFRASTRUCTURE_TO_FAIL },
    launch: gap(NODE_CONTRACT_SUITE),
    merge: { notApplicable: 'the merge node merges only on a green CI and starts no session; an abandoned run reaches it as not green, and its rerun belongs to netwatch and the update node' },
    restart: { notApplicable: NO_INFRASTRUCTURE_TO_FAIL },
    review: gap(NODE_CONTRACT_SUITE),
    update: gap(NODE_CONTRACT_SUITE),
    witness: gap(NODE_CONTRACT_SUITE),
    ...beyondNodes('Z2'),
  },
  Z3: { ...everyNode(gap(NO_IN_MEMORY_PORT)), answer: gap(NODE_CONTRACT_SUITE), ...beyondNodes('Z3') },
  Z4: { ...everyNode(gap(...WAIT_RECORDS)), launch: gap(CARD_WAIT_STATES, NO_HEAD_OF_LINE), ...beyondNodes('Z4') },
  Z5: { ...everyNode(gap(LAUNCH_EVENTS)), ...beyondNodes('Z5') },
  Z6: { ...everyNode(gap(TREE_WAY_BACK)), ...beyondNodes('Z6') },
  Z7: {
    answer: gap(NODE_CONTRACT_SUITE),
    close: { notApplicable: NO_SESSION_TO_READ },
    launch: gap(NODE_CONTRACT_SUITE),
    merge: { notApplicable: NO_SESSION_TO_READ },
    restart: { notApplicable: NO_SESSION_TO_READ },
    review: gap(REVIEW_STALL_IS_NOT_A_SILENT_LOOP),
    update: { notApplicable: NO_SESSION_TO_READ },
    witness: gap(NODE_CONTRACT_SUITE),
    ...beyondNodes('Z7'),
  },
}

export function sourceOf(site: LawSite): string {
  return site in SITES_BEYOND_NODES ? SITES_BEYOND_NODES[site as SiteBeyondNodes] : FACTORY_WORKERS[site as LawNode]
}

export function lawIds(): LawId[] {
  return Object.keys(LAWS) as LawId[]
}

export function gapRows(cells: LawCells = LAW_CELLS): GapRow[] {
  return lawIds().flatMap(law => LAW_SITES.flatMap((node) => {
    const cell = cells[law][node]
    return 'gap' in cell ? [{ law, node, cards: cell.gap }] : []
  }))
}
