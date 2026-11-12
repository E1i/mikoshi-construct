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
  Z8: 'the reason a session stops is recorded in the bus and decides whether its card is continued or goes to intake: a stop on paths outside the touches or on an open question spends no continuation, and the card is not launched again while its touches miss those paths or the question stays open',
  Z9: 'a decision that lifts an awaited stop also queues its answer',
  Z10: 'the owner\'s word moves any card past every timer and automatic condition — stop its live session, launch it now, give it to the window now, queue its task again without a board alarm — each an owner command given through the owner channel and recorded as one bus event naming the owner, refused only when the move is physically impossible, with that cause named',
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

const INTAKE_READS_DECISIONS = 1779
export const LAW_CELLS_WITNESSES = 1823
export const CARD_WAIT_STATES = 1740
const WAIT_STATES_AND_THEIR_WITNESSES = [CARD_WAIT_STATES, LAW_CELLS_WITNESSES]
export const NO_HEAD_OF_LINE = 1744
export const MERGE_KEEPS_TO_THE_TOUCHES = 1784
export const RESTART_KEEPS_SESSION = 'Z1-restart-keeps-session'
export const REVIEW_KEEPS_SESSION_AND_LEAVES_NO_DESCENDANT = 'Z1-review-keeps-session-and-leaves-no-descendant'
export const SESSION_BEAT_BESIDE_STALE_WINDOW = 'Z7-session-beat-beside-stale-window'
export const PULSE_BESIDE_CARD_SILENCE = 'Z7-pulse-beside-card-silence'
export const WINDOW_BESIDE_SESSIONS = 'Z7-window-beside-sessions'
export const REVIEW_LIVE_ON_ONE_STALE_SIGNAL = 'Z7-review-live-on-one-stale-signal'
export const INFRASTRUCTURE_RETRIED = 'Z2-infrastructure-retried'
export const ABANDONED_READ_AS_RERUN = 'Z2-abandoned-read-as-rerun'
export const LIVE_SESSION_WAIT_LIFTED = 'Z4-live-session-wait-lifted'
export const EVERY_LAUNCH_WRITES_ITS_EVENT = 'Z5-every-launch-writes-its-event'
export const DIRECT_IMPORTER_WIDENED = 'Z3-direct-importer-widened'
export const LAUNCH_BODY_FROM_LATEST_ADMISSION = 'Z3-launch-body-from-latest-admission'
export const LAUNCH_STOP_SPENDS_NO_CONTINUATION = 'Z8-launch-stop-spends-no-continuation'
export const ANSWER_STOP_SPENDS_NO_RESTART = 'Z8-answer-stop-spends-no-restart'
export const OWNER_LAUNCH_PAST_CONDITIONS = 'Z10-owner-launch-past-conditions'
const MOVES_NO_CARD_ON_THE_OWNERS_WORD = 'the owner\'s moves run as window requests the bus answers (scripts/window/window-requests.ts); this node holds no timer or condition an owner move passes'
const CONTINUES_NO_CARD_SESSION = 'the node continues no session of a card, so no stop of one decides a continuation here'
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
  Z7: gap(LAW_CELLS_WITNESSES),
  Z8: { notApplicable: 'netwatch continues no card session; it records what GitHub shows' },
  Z9: { notApplicable: 'netwatch records no decision and queues no answer; it records what GitHub shows' },
  Z10: { notApplicable: 'netwatch moves no card; it records what GitHub shows' },
}

const WINDOW: Record<LawId, LawCell> = {
  Z1: { notApplicable: 'miko:watch starts no session and no child process; it reads the bus and writes its own cursor' },
  Z2: gap(LAW_CELLS_WITNESSES),
  Z3: { notApplicable: 'the window is where these decisions are taken; the law is about the nodes that act on them' },
  Z4: gap(...WAIT_STATES_AND_THEIR_WITNESSES),
  Z5: { notApplicable: 'miko:watch launches nothing; a card the window starts is launched by the launch node, which writes the event' },
  Z6: { notApplicable: 'miko:watch writes no card tree, only its cursor beside the handoff' },
  Z7: { witness: WINDOW_BESIDE_SESSIONS },
  Z8: { notApplicable: 'miko:watch continues no card session; the launch and answer nodes decide a continuation from the stop they record' },
  Z9: { notApplicable: 'miko:watch queues no answer; the decision the window records reaches the answer and launch nodes through the bus' },
  Z10: { notApplicable: 'miko:watch moves no card; the owner\'s moves are window requests scripts/window/window-requests.ts answers, witnessed by scripts/tests/window/owner-moves-a-card.test.ts' },
}

const INTAKE: Record<LawId, LawCell> = {
  Z1: { notApplicable: 'intake starts no session and no child process' },
  Z2: { notApplicable: 'intake admits from the card text and the bus; it starts no session, runs no test and reads no CI run' },
  Z3: gap(INTAKE_READS_DECISIONS),
  Z4: gap(...WAIT_STATES_AND_THEIR_WITNESSES),
  Z5: { notApplicable: 'intake launches nothing; it admits a card the launch node later starts' },
  Z6: { notApplicable: 'intake writes the parking lane and the bus, never a card tree' },
  Z7: { notApplicable: 'intake reads no liveness: it admits from the card text, the decisions in force and the bus card states' },
  Z8: { notApplicable: 'intake continues no card session; it is where a card stopped outside its touches goes to have them widened' },
  Z9: { notApplicable: 'intake lifts no stop and queues no answer; it admits and widens cards' },
  Z10: { notApplicable: 'intake admits and widens cards and moves none on the owner\'s word' },
}

const SUPERVISOR: Record<LawId, LawCell> = {
  Z1: { notApplicable: 'StalledSessions starts no process; a session it ends it ends by name, which Z7 judges, not a child left behind' },
  Z2: gap(LAW_CELLS_WITNESSES),
  Z3: { notApplicable: 'StalledSessions applies the stall lines it is built with and takes no decision a window decision governs' },
  Z4: { notApplicable: 'StalledSessions opens no wait: it raises session.stalled, queues a dead session\'s task again or ends a review session' },
  Z5: { notApplicable: 'StalledSessions launches nothing' },
  Z6: { notApplicable: 'StalledSessions writes bus events and task releases, never a card tree' },
  Z7: { witness: REVIEW_LIVE_ON_ONE_STALE_SIGNAL },
  Z8: { notApplicable: 'StalledSessions continues no card session; it ends or requeues a stalled one and reads no stop reason' },
  Z9: { notApplicable: 'StalledSessions reads no decision and queues no answer to one' },
  Z10: { notApplicable: 'StalledSessions ends or requeues a stalled session by its stall lines and moves no card on the owner\'s word' },
}

function beyondNodes(law: LawId): Record<SiteBeyondNodes, LawCell> {
  return { netwatch: NETWATCH[law], window: WINDOW[law], intake: INTAKE[law], supervisor: SUPERVISOR[law] }
}

export const LAW_CELLS: LawCells = {
  Z1: {
    answer: gap(LAW_CELLS_WITNESSES),
    close: { notApplicable: STARTS_NO_SESSION },
    launch: gap(LAW_CELLS_WITNESSES),
    merge: { notApplicable: STARTS_NO_SESSION },
    restart: { notApplicable: STARTS_NO_SESSION },
    review: { witness: REVIEW_KEEPS_SESSION_AND_LEAVES_NO_DESCENDANT },
    update: { notApplicable: STARTS_NO_SESSION },
    witness: gap(LAW_CELLS_WITNESSES),
    ...beyondNodes('Z1'),
  },
  Z2: {
    answer: { witness: INFRASTRUCTURE_RETRIED },
    close: { notApplicable: NO_INFRASTRUCTURE_TO_FAIL },
    launch: { witness: INFRASTRUCTURE_RETRIED },
    merge: { notApplicable: 'the merge node merges only on a green CI and starts no session; an abandoned run reaches it as not green, and its rerun belongs to netwatch and the update node' },
    restart: { notApplicable: NO_INFRASTRUCTURE_TO_FAIL },
    review: gap(LAW_CELLS_WITNESSES),
    update: { witness: INFRASTRUCTURE_RETRIED },
    witness: gap(LAW_CELLS_WITNESSES),
    ...beyondNodes('Z2'),
  },
  Z3: {
    ...everyNode(gap(LAW_CELLS_WITNESSES)),
    answer: { witness: DIRECT_IMPORTER_WIDENED },
    launch: { witness: LAUNCH_BODY_FROM_LATEST_ADMISSION },
    merge: gap(MERGE_KEEPS_TO_THE_TOUCHES),
    ...beyondNodes('Z3'),
  },
  Z4: { ...everyNode(gap(...WAIT_STATES_AND_THEIR_WITNESSES)), answer: { witness: LIVE_SESSION_WAIT_LIFTED }, launch: gap(CARD_WAIT_STATES, NO_HEAD_OF_LINE), ...beyondNodes('Z4') },
  Z5: { ...everyNode(gap(LAW_CELLS_WITNESSES)), launch: { witness: EVERY_LAUNCH_WRITES_ITS_EVENT }, ...beyondNodes('Z5') },
  Z6: { ...everyNode(gap(LAW_CELLS_WITNESSES)), ...beyondNodes('Z6') },
  Z7: {
    answer: gap(LAW_CELLS_WITNESSES),
    close: { notApplicable: NO_SESSION_TO_READ },
    launch: gap(LAW_CELLS_WITNESSES),
    merge: { notApplicable: NO_SESSION_TO_READ },
    restart: { notApplicable: NO_SESSION_TO_READ },
    review: gap(LAW_CELLS_WITNESSES),
    update: { notApplicable: NO_SESSION_TO_READ },
    witness: gap(LAW_CELLS_WITNESSES),
    ...beyondNodes('Z7'),
  },
  Z8: {
    ...everyNode({ notApplicable: CONTINUES_NO_CARD_SESSION }),
    answer: { witness: ANSWER_STOP_SPENDS_NO_RESTART },
    launch: { witness: LAUNCH_STOP_SPENDS_NO_CONTINUATION },
    ...beyondNodes('Z8'),
  },
  Z9: {
    ...everyNode({ notApplicable: CONTINUES_NO_CARD_SESSION }),
    answer: gap(LAW_CELLS_WITNESSES),
    launch: gap(LAW_CELLS_WITNESSES),
    ...beyondNodes('Z9'),
  },
  Z10: {
    ...everyNode({ notApplicable: MOVES_NO_CARD_ON_THE_OWNERS_WORD }),
    launch: { witness: OWNER_LAUNCH_PAST_CONDITIONS },
    ...beyondNodes('Z10'),
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
