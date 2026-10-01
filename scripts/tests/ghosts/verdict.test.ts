import type { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { readContourSchema, violations } from '../../contract/contours.js'
import { checkVerdict, recordVerdict } from '../../ghosts/verdict.js'

const IMPLEMENT = '/implement the contour contracts (t)'
const REPORT = '[review:t]\nThe witnesses ran.\n'
const HEAD = 'c8c5d980643d31e43849b49688bef8ae84191f77'
const NOW = new Date('2026-10-01T02:00:00.000Z')

function sha256(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex')
}

function handoff(): { dir: string, verdict: string, journal: string, good: Record<string, unknown> } {
  const dir = mkdtempSync(path.join(tmpdir(), 'ghosts-verdict-'))
  writeFileSync(path.join(dir, 'brief-t.md'), `# Brief\n\n${IMPLEMENT}\n`)
  writeFileSync(path.join(dir, 'brief-t.approved-sha256'), `sha256: ${sha256(IMPLEMENT)}\n`)
  writeFileSync(path.join(dir, 'review-t.md'), REPORT)
  const good = { task: 't', verdict: 'changes', head: HEAD, brief: { path: 'brief-t.md', sha256: sha256(IMPLEMENT) }, report: { path: 'review-t.md', sha256: sha256(REPORT) } }
  return { dir, verdict: path.join(dir, 'review-t.verdict.json'), journal: path.join(dir, 'ghosts.jsonl'), good }
}

function write(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

function journalLines(journal: string): string[] {
  return existsSync(journal) ? readFileSync(journal, 'utf8').split('\n').filter(line => line !== '') : []
}

function reasonsOf(result: ReturnType<typeof checkVerdict>): string[] {
  return result.ok ? [] : result.reasons
}

describe('checkVerdict', () => {
  it('turns a good file into the journal line, with the digest of the verdict file itself', () => {
    const { dir, verdict, good } = handoff()
    write(verdict, good)
    const result = checkVerdict(verdict, dir, NOW)
    expect(result).toEqual({ ok: true, line: { event: 'review', ts: NOW.toISOString(), task: 't', verdict: 'changes', head: HEAD, brief: good.brief, report: good.report, file: { path: 'review-t.verdict.json', sha256: sha256(readFileSync(verdict)) } } })
  })

  it.each([
    { name: 'a verdict outside the enum', change: { verdict: 'merge' }, text: 'verdict: expected one of "pass", "changes"' },
    { name: 'a missing head', change: { head: undefined }, text: 'head: missing' },
    { name: 'a head that is not forty hex', change: { head: 'abc' }, text: 'head: does not match' },
    { name: 'a report digest that is not hex', change: { report: { path: 'review-t.md', sha256: 'zz' } }, text: 'report.sha256: does not match' },
  ])('refuses $name and prefixes the file', ({ change, text }) => {
    const { dir, verdict, good } = handoff()
    write(verdict, { ...good, ...change })
    const reasons = reasonsOf(checkVerdict(verdict, dir, NOW))
    expect(reasons.length).toBeGreaterThan(0)
    expect(reasons[0]).toContain(verdict)
    expect(reasons.join('\n')).toContain(text)
  })

  it('refuses a file that does not exist and a file that is not JSON', () => {
    const { dir, verdict } = handoff()
    expect(reasonsOf(checkVerdict(verdict, dir, NOW))).toEqual([`${verdict} does not exist`])
    writeFileSync(verdict, '{ nope')
    expect(reasonsOf(checkVerdict(verdict, dir, NOW))[0]).toContain(`${verdict} is not JSON: `)
  })

  it('refuses a missing report', () => {
    const { dir, verdict, good } = handoff()
    write(verdict, { ...good, report: { path: 'review-gone.md', sha256: sha256(REPORT) } })
    expect(reasonsOf(checkVerdict(verdict, dir, NOW))).toEqual(['report.path review-gone.md does not exist'])
  })

  it('refuses a brief with no approval file, an approval file with no hash, and another hash', () => {
    const { dir, verdict, good } = handoff()
    write(verdict, { ...good, brief: { path: 'brief-x.md', sha256: sha256(IMPLEMENT) } })
    expect(reasonsOf(checkVerdict(verdict, dir, NOW))).toEqual(['brief.path brief-x.md has no approval file brief-x.approved-sha256 next to it'])
    writeFileSync(path.join(dir, 'brief-x.approved-sha256'), 'nothing here\n')
    expect(reasonsOf(checkVerdict(verdict, dir, NOW))).toEqual(['no approval hash in brief-x.approved-sha256'])
    const other = sha256('/implement something else')
    write(verdict, { ...good, brief: { path: 'brief-t.md', sha256: other } })
    expect(reasonsOf(checkVerdict(verdict, dir, NOW))).toEqual([`brief.sha256 ${other} is not the approved hash in brief-t.approved-sha256 (${sha256(IMPLEMENT)})`])
  })
})

describe('recordVerdict', () => {
  it('refuses a report whose bytes no longer match the digest, naming both, and writes nothing', async () => {
    const { dir, verdict, journal, good } = handoff()
    write(verdict, good)
    writeFileSync(path.join(dir, 'review-t.md'), `${REPORT}An edit after the verdict.\n`)
    const edited = sha256(`${REPORT}An edit after the verdict.\n`)
    const result = await recordVerdict(verdict, dir)
    expect(reasonsOf(result)).toEqual([`report.sha256 ${sha256(REPORT)} is not the sha256 of review-t.md (${edited})`])
    expect(journalLines(journal)).toEqual([])
  })

  it('appends exactly one line to ghosts.jsonl in the handoff directory, and that line holds the journal schema', async () => {
    const { dir, verdict, journal, good } = handoff()
    write(verdict, good)
    const result = await recordVerdict(verdict, dir)
    expect(result.ok).toBe(true)
    const lines = journalLines(journal)
    expect(lines).toHaveLength(1)
    const root = readContourSchema('review-verdict')
    expect(violations(JSON.parse(lines[0]), { $ref: '#/$defs/journalLine' }, '', root)).toEqual([])
    expect(Object.keys(JSON.parse(lines[0])).sort()).toEqual(['brief', 'event', 'file', 'head', 'report', 'task', 'ts', 'verdict'])
  })

  it('writes nothing for any refusal, and appends to a journal that already holds lines', async () => {
    const { dir, verdict, journal, good } = handoff()
    writeFileSync(journal, '{"event":"task"}\n')
    write(verdict, { ...good, verdict: 'merge' })
    expect((await recordVerdict(verdict, dir)).ok).toBe(false)
    expect(journalLines(journal)).toEqual(['{"event":"task"}'])
    write(verdict, good)
    expect((await recordVerdict(verdict, dir)).ok).toBe(true)
    expect(journalLines(journal)).toHaveLength(2)
  })
})
