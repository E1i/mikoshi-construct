import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { readHandoff } from '../../board/handoff.js'

const SHA = 'a'.repeat(64)
const HEAD = 'c8c5d980643d31e43849b49688bef8ae84191f77'

const CHECKED = {
  event: 'review',
  ts: '2026-10-01T02:00:00.000Z',
  task: 't',
  verdict: 'pass',
  head: HEAD,
  brief: { path: 'brief-t.md', sha256: SHA },
  report: { path: 'review-t.md', sha256: SHA },
  file: { path: 'review-t.verdict.json', sha256: SHA },
}

const LEGACY = { event: 'review', task: 'old', verdict: 'pass-by-evidence', note: 'by hand', ts: '2026-09-28T04:59:20.000Z' }

function handoffWith(lines: unknown[]): ReturnType<typeof readHandoff> {
  const dir = mkdtempSync(path.join(tmpdir(), 'board-review-'))
  writeFileSync(path.join(dir, 'ghosts.jsonl'), `${lines.map(line => JSON.stringify(line)).join('\n')}\n`)
  return readHandoff(dir)
}

function reviewOf(handoff: ReturnType<typeof readHandoff>, id: string): unknown {
  return handoff.attempts.find(attempt => attempt.id === id)?.reviewEvent
}

describe('readHandoff reads a review line through contract/contours/review-verdict.schema.json', () => {
  it('keeps a line that holds contract/contours/review-verdict.schema.json, with its head and digests', () => {
    const handoff = handoffWith([CHECKED])
    expect(reviewOf(handoff, 't')).toEqual(CHECKED)
    expect(handoff.warnings).toEqual([])
  })

  it('skips a line that carries the checker\'s file field but does not hold the schema, naming the line and the fault', () => {
    const broken = { ...CHECKED, task: 'u', report: { path: 'review-u.md', sha256: 'zz' } }
    const handoff = handoffWith([CHECKED, broken])
    expect(reviewOf(handoff, 'u')).toBeUndefined()
    expect(handoff.warnings).toEqual(['ghosts.jsonl line 2 is a review line that does not hold contract/contours/review-verdict.schema.json (report.sha256: does not match ^[0-9a-f]{64}$); skipped'])
  })

  it('reads a line written by hand before the checker existed as it is', () => {
    const handoff = handoffWith([LEGACY, { event: 'review', task: 'older', verdict: 'changes', ts: '2026-09-27T04:59:20.000Z' }])
    expect(reviewOf(handoff, 'old')).toEqual(LEGACY)
    expect(reviewOf(handoff, 'older')).toMatchObject({ verdict: 'changes' })
    expect(handoff.warnings).toEqual([])
  })

  it('does not read any other event through the review schema', () => {
    const handoff = handoffWith([{ event: 'merge', task: 'm', by: 'eli', commit: 'abc', ts: '2026-10-01T03:00:00.000Z', file: 'not a digest' }])
    expect(handoff.warnings).toEqual([])
  })
})
