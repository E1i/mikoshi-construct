import type { Card } from '../../src/card/grammar.js'
import type { RiskLevel } from '../../src/card/risk.js'
import type { ReviewDepth } from '../ghosts/verdict.js'
import path from 'node:path'
import { approvalOf, approvalSha256, canonicalImplementText, revocationOf } from '../ghosts/approval.js'

export type LadderStep
  = | { kind: 'brief' }
    | { kind: 'launch', sha256: string }
    | { kind: 'running' }
    | { kind: 'review' }
    | { kind: 'fault', why: string }

export interface LadderFacts {
  journal: string | null
  brief: string | null
}

const SHORT_HASH = 7

export function isLadder(card: Card): boolean {
  return card.kind === 'implement' && card.contour === 'ladder'
}

export function briefPathOf(handoffDir: string, card: Card): string {
  return path.join(handoffDir, `brief-${card.id}-${card.name}.md`)
}

export function tasksFilePathOf(handoffDir: string, card: Card): string {
  return path.join(handoffDir, `tasks-${card.id}-${card.name}.json`)
}

export function approvedSha256Of(facts: LadderFacts, card: Card): string | null {
  const text = facts.brief === null ? undefined : canonicalImplementText(facts.brief)
  if (text === undefined)
    return null
  const sha256 = approvalSha256(text)
  const events = journalLines(facts.journal)
  return approvalOf(events, sha256, card.id) !== undefined && revocationOf(events, sha256, card.id) === undefined ? sha256 : null
}

function journalLines(journal: string | null): Record<string, unknown>[] {
  return (journal ?? '').split('\n').flatMap((text) => {
    try {
      const line = JSON.parse(text) as unknown
      return line !== null && typeof line === 'object' && !Array.isArray(line) ? [line as Record<string, unknown>] : []
    }
    catch {
      return []
    }
  })
}

function launchedUnder(line: Record<string, unknown>, card: Card, sha256: string): boolean {
  return line.event === 'entry' && line.task === card.name && typeof line.CONTRACT === 'string' && line.CONTRACT.includes(`approved ${sha256.slice(0, SHORT_HASH)}`)
}

function ghostEnded(line: Record<string, unknown>, card: Card, sha256: string): boolean {
  return line.event === 'task' && line.task === card.name && line.approvedSha256 === sha256
}

export function ladderStep(facts: LadderFacts, card: Card): LadderStep {
  const sha256 = approvedSha256Of(facts, card)
  if (sha256 === null)
    return { kind: 'brief' }
  const lines = journalLines(facts.journal)
  const launchedAt = lines.map(line => launchedUnder(line, card, sha256)).lastIndexOf(true)
  if (launchedAt === -1)
    return { kind: 'launch', sha256 }
  const ended = lines.slice(launchedAt + 1).find(line => ghostEnded(line, card, sha256))
  if (ended === undefined)
    return { kind: 'running' }
  return ended.ladder === 'done' ? { kind: 'review' } : { kind: 'fault', why: `the Ghost ended with ladder status '${String(ended.ladder)}'` }
}

export function tasksFileText(card: Card, parts: { repo: string, handoffDir: string, brief: string }): string {
  const tasks = [{ id: card.name, brief: parts.brief, card: card.line }]
  return `${JSON.stringify({ repo: parts.repo, status: path.join(parts.handoffDir, 'status.md'), out: parts.handoffDir, tasks }, null, 2)}\n`
}

export function briefBody(card: Card, brief: string): string {
  return [
    `Ladder route, step 1 of 3 for card #${card.id} ${card.name}: the design and the brief. Do not implement the card.`,
    `Work as \`.claude/agents/brief.md\` does: design the change, build the working sketch on \`sketch/${card.name}\`, write the brief to \`${brief}\`, and run \`pnpm ghosts:hash ${brief}\` (no \`--by\`) until it prints an approval line.`,
    'Never write an `.approved-sha256` file and never pass `--by` to `ghosts:hash`: the shift asks for the approval itself after you exit.',
    'The report says `no PR`.',
  ].join('\n')
}

const REVIEW_STEP: Record<ReviewDepth, string> = {
  full: 'Run the blind Design scan (`.claude/agents/scan.md`), then the full review (`.claude/agents/review.md`: witnesses, mutations, the Design walk), then `pnpm ghosts:verdict` on its verdict file, and open the pull request.',
  diff: 'Run the review (`.claude/agents/review.md`) at depth diff: it reads the diff only, with no Design scan, no mutations and no Design walk; then `pnpm ghosts:verdict` on its verdict file, and open the pull request.',
  none: 'Launch no review agent and no Design scan: the witnesses and CI decide. Run the brief\'s witnesses and `pnpm run quality`, and open the pull request.',
}

export function reviewBody(card: Card, brief: string, review: { risk: RiskLevel, depth: ReviewDepth }): string {
  return [
    `Ladder route, step 3 of 3 for card #${card.id} ${card.name}: the Ghost ended with ladder done in your tree, on the brief \`${brief}\`.`,
    `Review depth ${review.depth}, from risk ${review.risk}. ${REVIEW_STEP[review.depth]}`,
    'The report carries the pull request on a line of its own, `PR #N`, and a `verification:` line.',
  ].join('\n')
}
