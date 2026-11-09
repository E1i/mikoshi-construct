import type { DatabaseSync } from 'node:sqlite'
import type { Lease } from '../../../core/lease.js'
import type { AnswerSource, CardSession } from '../answer-source.js'
import type { TreeMerge } from './tree.js'
import { CLOSED_WAIT, OWNER_WAITS } from '../../../core/bus-readings.js'
import { WITNESS_RECORDED } from '../../../core/events.js'
import { MAIN_BRANCH } from '../../../ports/snapshot.js'
import { answerSourceOf, boundDecisionLines } from '../answer-source.js'

export type Answering = AnswerSource & { reentry?: true }

export interface SourceParts {
  db: DatabaseSync
  clock: () => Date
}

const CLOSED_WAITS_OF_THE_CARD = `SELECT id, answer FROM ${OWNER_WAITS} WHERE card_id = ? AND state = '${CLOSED_WAIT}' ORDER BY event_id`

const DIRTY_ON_HEAD = `SELECT 1 FROM prs WHERE pr = ? AND head = ? AND state = 'open' AND mergeable = 'dirty'`

const RED_WITNESS_ON_HEAD = `
  SELECT json_extract(red.payload, '$.detail') AS detail FROM events AS red
  WHERE red.id = (SELECT max(latest.id) FROM events AS latest WHERE latest.type = '${WITNESS_RECORDED}' AND latest.legacy = 0 AND latest.pr = ? AND latest.head = ?)
    AND json_extract(red.payload, '$.verdict') = 'red'
`

export class AnswerSources {
  constructor(private readonly parts: SourceParts) {}

  sourceOf(lease: Lease): Answering | null {
    const source = answerSourceOf(this.parts.db, lease, this.parts.clock())
    if (source?.kind === 'question')
      return { ...source, decisions: [...source.decisions, ...this.closedWaitLines(lease)] }
    if (source !== null && source.kind !== 'ci')
      return source
    const witness = this.redWitness(lease)
    if (witness === null)
      return source
    return source === null ? witness : { ...witness, failedChecks: source.failedChecks }
  }

  boundDecisions(lease: Lease): string[] {
    return boundDecisionLines(this.parts.db, lease.cardId, this.parts.clock())
  }

  dirtyOnHead(lease: Lease): boolean {
    return lease.pr !== null && lease.head !== null && this.parts.db.prepare(DIRTY_ON_HEAD).get(lease.pr, lease.head) !== undefined
  }

  conflict(lease: Lease, card: CardSession, merge: TreeMerge | null): AnswerSource {
    const conflicts = `pull request #${lease.pr} conflicts with ${MAIN_BRANCH} at ${lease.head}`
    const decisions = this.boundDecisions(lease)
    if (merge?.kind !== 'mid-merge')
      return { kind: 'changes', findings: [`${conflicts}: merge origin/${MAIN_BRANCH} into the branch and resolve every conflict, keeping what the card asks for`], events: [], decisions }
    const unmerged = merge.files.length === 0 ? '' : ` with ${merge.files.join(', ')} unmerged`
    return { kind: 'changes', findings: [`${conflicts}, and its tree ${card.worktree} stands mid-merge${unmerged}: finish that merge where it stands, resolving every unmerged path keeping what the card asks for and staging it with git -C ${card.worktree} add, and leave the commit that concludes the merge to the bus; never git merge --abort, git reset or a new merge over it`], events: [], decisions }
  }

  private redWitness(lease: Lease): Answering & { kind: 'changes' } | null {
    if (lease.pr === null || lease.head === null)
      return null
    const red = this.parts.db.prepare(RED_WITNESS_ON_HEAD).get(lease.pr, lease.head) as { detail: unknown } | undefined
    if (red === undefined)
      return null
    const detail = typeof red.detail === 'string' && red.detail !== '' ? red.detail : 'the bus recorded no detail'
    return { kind: 'changes', findings: [`the card's witness is red on ${lease.head}: ${detail}`], events: [], decisions: this.boundDecisions(lease), reentry: true }
  }

  private closedWaitLines(lease: Lease): string[] {
    const closed = this.parts.db.prepare(CLOSED_WAITS_OF_THE_CARD).all(lease.cardId) as { id: string, answer: string | null }[]
    return closed.map(wait => `${wait.id} is closed: ${wait.answer ?? 'no answer recorded'}`)
  }
}
