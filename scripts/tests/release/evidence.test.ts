import type { EvidenceDeps } from '../../release/evidence.js'
import { describe, expect, it } from 'vitest'
import { runEvidence } from '../../release/evidence.js'

const JOURNAL = '/handoff/ghosts.jsonl'
const SHIFT = '/shift/r1'
const COMMIT = 'a'.repeat(40)
const OUTSIDE = 'b'.repeat(40)
const CARD = { id: 7, name: 'seven', kind: 'implement', milestone: 'runner', size: 'XS', contour: 'cheap', decision: 'auto', depends: [], blocks: [], line: '#7 seven [implement/runner/XS/cheap/auto] · depends — · blocks —' }

const intake = { event: 'intake', task: '7', card: CARD.line, confirmation: 'none', corrections: [], ts: 't0' }
const merge = { event: 'merge', task: '7', pr: 70, by: 'E1i', commit: COMMIT, merged: '2026-10-07T00:00:00Z', ts: 't9' }

function world(journal: object[], files: Record<string, string> = {}): EvidenceDeps {
  const all: Record<string, string> = { [JOURNAL]: journal.map(line => JSON.stringify(line)).join('\n'), ...files }
  return { journal: JOURNAL, read: file => all[file] ?? null, commits: () => new Set([COMMIT]) }
}

function field(stdout: string[], name: string): string {
  return stdout.find(line => line.startsWith(`  ${name}: `))!
}

describe('release:evidence prints the execution profile of every merged card in the range', () => {
  it('a field without a source prints unknown and budget prints gap', () => {
    const start = { event: 'path', task: '7', path: 'cheap', card: CARD, ts: 't1' }
    const { stdout, exitCode } = runEvidence(['v1', 'v2'], world([intake, start, merge]))

    expect(exitCode).toBe(0)
    expect(stdout[0]).toBe(`#7 · PR #70 · commit ${COMMIT.slice(0, 7)}`)
    for (const name of ['who', 'risk', 'forecast', 'actual', 'result.verification', 'result.stop', 'result.review'])
      expect(field(stdout, name)).toMatch(new RegExp(`^  ${name}: unknown — no `))
    expect(field(stdout, 'merge.shift')).toBe(`  merge.shift: unknown — no shift recorded on the start line in ${JOURNAL}`)
    expect(field(stdout, 'budget')).toBe('  budget: gap — no budget is recorded apart from the forecast')
    expect(stdout.join('\n')).not.toMatch(/budget: (?!gap)/)
    expect(field(stdout, 'confirmation')).toBe(`  confirmation: none · corrections [] — ${JOURNAL}:1`)
    expect(field(stdout, 'size')).toBe(`  size: XS — ${JOURNAL}:2`)
    expect(field(stdout, 'result.merge')).toBe(`  result.merge: PR #70 by E1i at 2026-10-07T00:00:00Z — ${JOURNAL}:3`)
  })

  it('risk comes only from the recorded risk', () => {
    const bare = { event: 'path', task: '7', path: 'cheap', card: { ...CARD, size: 'L', contour: 'ladder' }, ts: 't1' }
    expect(field(runEvidence(['v1', 'v2'], world([intake, bare, merge])).stdout, 'risk')).toMatch(/^ {2}risk: unknown — /)

    const risk = { level: 'R3', text: 'R3 — moderate: written on the card' }
    const recorded = { ...bare, risk }
    expect(field(runEvidence(['v1', 'v2'], world([intake, recorded, merge])).stdout, 'risk')).toBe(`  risk: ${risk.text} — ${JOURNAL}:2`)
  })

  it('prints every recorded field with the line it came from, the forecast apart from the budget', () => {
    const start = { event: 'path', task: '7', path: 'cheap', card: CARD, who: 'shift', shift: SHIFT, forecast: { tokens: 67000, minutes: 4.4, class: 'implement/XS', n: 31 }, ts: 't1' }
    const close = { event: 'path', task: '7', path: 'cheap', pr: 70, verification: 'run', actual: { tokens: 84685, minutes: null }, ts: 't2' }
    const stop = { event: 'stop', task: '7', at: 'merge', ts: 't3' }
    const review = { event: 'review', task: '7', verdict: 'accept', ts: 't4' }
    const shiftLine = { event: 'task', task: '7', merge: ['[shift:merge] decision auto, no owner path — auto-merge armed on PR #70 at abc'] }
    const deps = world([intake, start, close, stop, review, merge], { [`${SHIFT}/shift.jsonl`]: `{"event":"start"}\n${JSON.stringify(shiftLine)}` })

    const { stdout } = runEvidence(['v1', 'v2'], deps)

    expect(field(stdout, 'who')).toBe(`  who: shift — ${JOURNAL}:2`)
    expect(field(stdout, 'contour')).toBe(`  contour: cheap — ${JOURNAL}:2`)
    expect(field(stdout, 'merge.decision')).toBe(`  merge.decision: auto — ${JOURNAL}:2`)
    expect(field(stdout, 'merge.shift')).toBe(`  merge.shift: ${shiftLine.merge[0]} — ${SHIFT}/shift.jsonl:2`)
    expect(field(stdout, 'forecast')).toBe(`  forecast: tokens ≈ 67000, minutes ≈ 4.4 — class implement/XS, n=31 — ${JOURNAL}:2`)
    expect(field(stdout, 'budget')).toBe('  budget: gap — no budget is recorded apart from the forecast')
    expect(field(stdout, 'actual')).toBe(`  actual: tokens 84685, minutes unknown — ${JOURNAL}:3`)
    expect(field(stdout, 'result.verification')).toBe(`  result.verification: run — ${JOURNAL}:3`)
    expect(field(stdout, 'result.stop')).toBe(`  result.stop: merge — ${JOURNAL}:4`)
    expect(field(stdout, 'result.review')).toBe(`  result.review: accept — ${JOURNAL}:5`)
  })

  it('leaves out a merge line whose commit is outside the range', () => {
    const { stdout } = runEvidence(['v1', 'v2'], world([intake, { ...merge, commit: OUTSIDE }]))

    expect(stdout).toEqual([`no merge line in ${JOURNAL} has a commit in v1..v2`])
  })

  it('refuses without exactly two revisions', () => {
    expect(runEvidence(['v1'], world([])).exitCode).toBe(1)
  })
})
