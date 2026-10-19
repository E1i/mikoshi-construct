import type { ParkedTask } from '../../src/card/parking.js'
import type { LastHeartbeat } from './heartbeat.js'
import { RISK_PREFIX, SEAM_PREFIX, SLICE_PREFIX } from '../../src/card/risk.js'
import { witnessesOf } from '../../src/commands/intake/admit.js'
import { UNCLEAR_PREFIX, WITNESSES_HEADING } from '../../src/commands/intake/slice.js'
import { CARD_PATH_REASON } from '../shift/tree-pr.js'

export const CONTRACTS = ['intake', 'start', 'review', 'close', 'board'] as const

export type Contract = typeof CONTRACTS[number]

export interface CardBody {
  admissionEventId: number
  text: string
  textSha: string
  lane: string | null
  state: string | null
  lastHeartbeat: LastHeartbeat | null
}

export interface CardFields {
  id: number
  name: string
  kind: string
  milestone: string
  size: string
  contour: string
  decision: string
  depends: number[]
  blocks: number[]
  cardLine: string
  branch: string
  touches: string[]
  continue: string
  who: string
  priority: string | null
  creates: string[]
  prose: string
  witnesses: string[]
  unclear: string[]
  risk: string | null
  seam: string[]
  slice: string[]
  path: string | null
  lane: string | null
  text: string
  textSha: string
  admissionEventId: number
  state: string | null
  lastHeartbeat: LastHeartbeat | null
}

const CARD_FIELDS = ['id', 'name', 'kind', 'milestone', 'size', 'contour', 'decision', 'depends', 'blocks', 'cardLine', 'branch', 'touches', 'continue', 'who', 'priority', 'creates', 'prose', 'witnesses', 'unclear', 'risk', 'seam', 'slice', 'path', 'lane'] as const satisfies readonly (keyof CardFields)[]

export const CONTRACT_FIELDS: Record<Contract, readonly (keyof CardFields)[]> = {
  intake: [...CARD_FIELDS, 'text'],
  start: ['id', 'name', 'cardLine', 'branch', 'contour', 'path', 'touches', 'who', 'risk', 'lane', 'textSha', 'lastHeartbeat'],
  review: ['id', 'cardLine', 'branch', 'continue', 'touches', 'risk', 'prose', 'witnesses', 'unclear', 'text', 'lastHeartbeat'],
  close: ['id', 'cardLine', 'text'],
  board: ['id', 'name', 'contour', 'priority', 'who', 'depends', 'touches', 'creates', 'lane', 'state'],
}

export function isContract(name: string): name is Contract {
  return (CONTRACTS as readonly string[]).includes(name)
}

function proseOf(body: string): string {
  const lines = body.split('\n')
  const witnesses = lines.findIndex(line => line.trim() === WITNESSES_HEADING)
  return (witnesses === -1 ? lines : lines.slice(0, witnesses)).join('\n').trim()
}

function prefixed(body: string, prefix: string): string[] {
  return body.split('\n').filter(line => line.startsWith(prefix)).map(line => line.slice(prefix.length).trim())
}

export function cardFields(parked: ParkedTask, body: CardBody): CardFields {
  const { task } = parked
  const { card } = task
  return {
    id: card.id,
    name: card.name,
    kind: card.kind,
    milestone: card.milestone,
    size: card.size,
    contour: card.contour,
    decision: card.decision,
    depends: card.depends,
    blocks: card.blocks,
    cardLine: card.line,
    branch: task.branch,
    touches: task.touches,
    continue: task.continue,
    who: parked.who,
    priority: parked.priority,
    creates: parked.creates,
    prose: proseOf(task.body),
    witnesses: witnessesOf(task.body),
    unclear: prefixed(task.body, UNCLEAR_PREFIX),
    risk: prefixed(task.body, RISK_PREFIX)[0] ?? null,
    seam: prefixed(task.body, SEAM_PREFIX),
    slice: prefixed(task.body, SLICE_PREFIX),
    path: CARD_PATH_REASON.exec(task.body)?.[1]?.trim() ?? null,
    lane: body.lane,
    text: body.text,
    textSha: body.textSha,
    admissionEventId: body.admissionEventId,
    state: body.state,
    lastHeartbeat: body.lastHeartbeat,
  }
}

export function contractOf(fields: CardFields, contract: Contract): Partial<CardFields> {
  return Object.fromEntries(CONTRACT_FIELDS[contract].map(field => [field, fields[field]]))
}
