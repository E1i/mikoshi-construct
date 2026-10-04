import type { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { readContourSchema, violations } from '../../contract/contours.js'
import { checkDisposition, checkVerdict, recordDisposition, recordVerdict } from '../../ghosts/verdict.js'

const IMPLEMENT = '/implement the contour contracts (t)'
const REPORT = '[review:t]\nThe witnesses ran.\n'
const NOW = new Date('2026-10-01T02:00:00.000Z')

function git(repo: string, ...args: string[]): string {
  return execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function commitTree(repo: string, file: string): { commit: string, tree: string } {
  writeFileSync(path.join(repo, file), `${file}\n`)
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', file)
  return { commit: git(repo, 'rev-parse', 'HEAD'), tree: git(repo, 'rev-parse', 'HEAD^{tree}') }
}

const REPO = mkdtempSync(path.join(tmpdir(), 'ghosts-verdict-repo-'))
git(REPO, 'init', '-q')
const BASE = commitTree(REPO, 'reviewed-on')
const PR = commitTree(REPO, 'committed-after')
const TARGET = { commit: PR.commit, repo: REPO }

function sha256(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex')
}

function handoff(): { dir: string, verdict: string, journal: string, good: Record<string, unknown> } {
  const dir = mkdtempSync(path.join(tmpdir(), 'ghosts-verdict-'))
  writeFileSync(path.join(dir, 'brief-t.md'), `# Brief\n\n${IMPLEMENT}\n`)
  writeFileSync(path.join(dir, 'brief-t.approved-sha256'), `sha256: ${sha256(IMPLEMENT)}\n`)
  writeFileSync(path.join(dir, 'review-t.md'), REPORT)
  const good = { task: 't', verdict: 'changes', head: BASE.commit, tree: PR.tree, brief: { path: 'brief-t.md', sha256: sha256(IMPLEMENT) }, report: { path: 'review-t.md', sha256: sha256(REPORT) } }
  return { dir, verdict: path.join(dir, 'review-t.verdict.json'), journal: path.join(dir, 'ghosts.jsonl'), good }
}

function write(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

function journalLines(journal: string): string[] {
  return existsSync(journal) ? readFileSync(journal, 'utf8').split('\n').filter(line => line !== '') : []
}

function reasonsOf(result: { ok: true } | { ok: false, reasons: string[] }): string[] {
  return result.ok ? [] : result.reasons
}

describe('checkVerdict', () => {
  it('turns a good file into the journal line, with the digest of the verdict file itself', () => {
    const { dir, verdict, good } = handoff()
    write(verdict, good)
    const result = checkVerdict(verdict, dir, TARGET, NOW)
    expect(result).toEqual({ ok: true, line: { event: 'review', ts: NOW.toISOString(), task: 't', verdict: 'changes', head: BASE.commit, tree: PR.tree, commit: PR.commit, brief: good.brief, report: good.report, file: { path: 'review-t.verdict.json', sha256: sha256(readFileSync(verdict)) } } })
  })

  it.each([
    { name: 'a verdict outside the enum', change: { verdict: 'merge' }, text: 'verdict: expected one of "pass", "changes"' },
    { name: 'a missing head', change: { head: undefined }, text: 'head: missing' },
    { name: 'a head that is not forty hex', change: { head: 'abc' }, text: 'head: does not match' },
    { name: 'a report digest that is not hex', change: { report: { path: 'review-t.md', sha256: 'zz' } }, text: 'report.sha256: does not match' },
  ])('refuses $name and prefixes the file', ({ change, text }) => {
    const { dir, verdict, good } = handoff()
    write(verdict, { ...good, ...change })
    const reasons = reasonsOf(checkVerdict(verdict, dir, TARGET, NOW))
    expect(reasons.length).toBeGreaterThan(0)
    expect(reasons[0]).toContain(verdict)
    expect(reasons.join('\n')).toContain(text)
  })

  it('refuses a verdict whose tree is not the tree of the PR commit, naming both trees (W1)', () => {
    const { dir, verdict, good } = handoff()
    write(verdict, { ...good, tree: BASE.tree })
    expect(reasonsOf(checkVerdict(verdict, dir, TARGET, NOW))).toEqual([`verdict tree ${BASE.tree} is not the tree of ${PR.commit} (${PR.tree})`])
  })

  it('passes a verdict whose tree is the PR commit\'s though its head is the base it was reviewed on, and carries tree and commit into the line (W2)', () => {
    const { dir, verdict, good } = handoff()
    write(verdict, good)
    const result = checkVerdict(verdict, dir, TARGET, NOW)
    expect(result.ok).toBe(true)
    expect(result.ok && result.line).toMatchObject({ head: BASE.commit, tree: PR.tree, commit: PR.commit })
  })

  it('refuses a verdict with no tree for that reason, not as a pass (W3)', () => {
    const { dir, verdict, good } = handoff()
    write(verdict, { ...good, tree: undefined })
    expect(reasonsOf(checkVerdict(verdict, dir, TARGET, NOW))).toEqual([`${verdict}: verdict has no tree`])
  })

  it('refuses a commit the repository does not have', () => {
    const { dir, verdict, good } = handoff()
    write(verdict, good)
    const missing = '0'.repeat(40)
    expect(reasonsOf(checkVerdict(verdict, dir, { commit: missing, repo: REPO }, NOW))).toEqual([`commit ${missing} is not a commit in ${REPO}`])
  })

  it('reads a journal line written before verdicts carried a tree as a valid line (control)', () => {
    const old = { event: 'review', ts: NOW.toISOString(), task: 't', verdict: 'pass', head: BASE.commit, brief: { path: 'brief-t.md', sha256: sha256(IMPLEMENT) }, report: { path: 'review-t.md', sha256: sha256(REPORT) }, file: { path: 'review-t.verdict.json', sha256: sha256('old') } }
    expect(violations(old, { $ref: '#/$defs/journalLine' }, '', readContourSchema('review-verdict'))).toEqual([])
  })

  it('refuses a file that does not exist and a file that is not JSON', () => {
    const { dir, verdict } = handoff()
    expect(reasonsOf(checkVerdict(verdict, dir, TARGET, NOW))).toEqual([`${verdict} does not exist`])
    writeFileSync(verdict, '{ nope')
    expect(reasonsOf(checkVerdict(verdict, dir, TARGET, NOW))[0]).toContain(`${verdict} is not JSON: `)
  })

  it('refuses a missing report', () => {
    const { dir, verdict, good } = handoff()
    write(verdict, { ...good, report: { path: 'review-gone.md', sha256: sha256(REPORT) } })
    expect(reasonsOf(checkVerdict(verdict, dir, TARGET, NOW))).toEqual(['report.path review-gone.md does not exist'])
  })

  it('refuses a brief with no approval file, an approval file with no hash, and another hash', () => {
    const { dir, verdict, good } = handoff()
    write(verdict, { ...good, brief: { path: 'brief-x.md', sha256: sha256(IMPLEMENT) } })
    expect(reasonsOf(checkVerdict(verdict, dir, TARGET, NOW))).toEqual(['brief.path brief-x.md has no approval file brief-x.approved-sha256 next to it'])
    writeFileSync(path.join(dir, 'brief-x.approved-sha256'), 'nothing here\n')
    expect(reasonsOf(checkVerdict(verdict, dir, TARGET, NOW))).toEqual(['no approval hash in brief-x.approved-sha256'])
    const other = sha256('/implement something else')
    write(verdict, { ...good, brief: { path: 'brief-t.md', sha256: other } })
    expect(reasonsOf(checkVerdict(verdict, dir, TARGET, NOW))).toEqual([`brief.sha256 ${other} is not the approved hash in brief-t.approved-sha256 (${sha256(IMPLEMENT)})`])
  })
})

describe('recordVerdict', () => {
  it('refuses a report whose bytes no longer match the digest, naming both, and writes nothing', async () => {
    const { dir, verdict, journal, good } = handoff()
    write(verdict, good)
    writeFileSync(path.join(dir, 'review-t.md'), `${REPORT}An edit after the verdict.\n`)
    const edited = sha256(`${REPORT}An edit after the verdict.\n`)
    const result = await recordVerdict(verdict, dir, TARGET)
    expect(reasonsOf(result)).toEqual([`report.sha256 ${sha256(REPORT)} is not the sha256 of review-t.md (${edited})`])
    expect(journalLines(journal)).toEqual([])
  })

  it('refuses a verdict whose task is not the one the report names in its [review:<task>] line, and writes nothing', async () => {
    const { dir, verdict, journal, good } = handoff()
    write(verdict, { ...good, task: 'u' })
    const result = await recordVerdict(verdict, dir, TARGET)
    expect(reasonsOf(result)).toEqual(['task u: review-t.md starts with "[review:t]", not [review:u]'])
    expect(journalLines(journal)).toEqual([])
  })

  it('refuses a report whose marker names a card number and points to the task id from the tasks file, and writes nothing', async () => {
    const { dir, verdict, journal, good } = handoff()
    const cardReport = '[review:129]\nThe witnesses ran.\n'
    writeFileSync(path.join(dir, 'review-t.md'), cardReport)
    write(verdict, { ...good, report: { path: 'review-t.md', sha256: sha256(cardReport) } })
    const result = await recordVerdict(verdict, dir, TARGET)
    expect(reasonsOf(result)).toEqual(['task t: review-t.md starts with "[review:129]", not [review:t]; the marker names a card number; the review marker takes the task id t from the tasks file'])
    expect(journalLines(journal)).toEqual([])
  })

  it('appends exactly one line to ghosts.jsonl in the handoff directory, and that line holds the journal schema', async () => {
    const { dir, verdict, journal, good } = handoff()
    write(verdict, good)
    const result = await recordVerdict(verdict, dir, TARGET)
    expect(result.ok).toBe(true)
    const lines = journalLines(journal)
    expect(lines).toHaveLength(1)
    const root = readContourSchema('review-verdict')
    expect(violations(JSON.parse(lines[0]), { $ref: '#/$defs/journalLine' }, '', root)).toEqual([])
    expect(Object.keys(JSON.parse(lines[0])).sort()).toEqual(['brief', 'commit', 'event', 'file', 'head', 'report', 'task', 'tree', 'ts', 'verdict'])
  })

  it('writes nothing for any refusal, and appends to a journal that already holds lines', async () => {
    const { dir, verdict, journal, good } = handoff()
    writeFileSync(journal, '{"event":"task"}\n')
    write(verdict, { ...good, verdict: 'merge' })
    expect((await recordVerdict(verdict, dir, TARGET)).ok).toBe(false)
    expect(journalLines(journal)).toEqual(['{"event":"task"}'])
    write(verdict, good)
    expect((await recordVerdict(verdict, dir, TARGET)).ok).toBe(true)
    expect(journalLines(journal)).toHaveLength(2)
  })
})

describe('recordDisposition', () => {
  const INPUT = { task: 't', pr: '520', followUp: '519', by: 'window' }

  it('appends one disposition line to ghosts.jsonl and reads it back as written', async () => {
    const { dir, journal } = handoff()
    writeFileSync(journal, '{"event":"review","task":"t","verdict":"changes"}\n')
    const result = await recordDisposition(INPUT, dir, NOW)
    const line = { event: 'disposition', ts: NOW.toISOString(), task: 't', decision: 'merge-follow-up', pr: 520, followUp: 519, by: 'window' }
    expect(result).toEqual({ ok: true, line })
    const lines = journalLines(journal)
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[1])).toEqual(line)
  })

  it('takes the owner as the one who decided', () => {
    const result = checkDisposition({ ...INPUT, by: 'owner' }, NOW)
    expect(result.ok && result.line.by).toBe('owner')
  })

  it.each([
    { name: 'a missing task', change: { task: undefined }, text: '--task is missing' },
    { name: 'a pull request that is not a number', change: { pr: '#520' }, text: '--pr #520 is not a positive number' },
    { name: 'a missing follow-up', change: { followUp: undefined }, text: '--follow-up (missing) is not a positive number' },
    { name: 'a decider outside owner and window', change: { by: 'review' }, text: '--by review is not one of owner, window' },
  ])('refuses $name and writes nothing', async ({ change, text }) => {
    const { dir, journal } = handoff()
    const result = await recordDisposition({ ...INPUT, ...change }, dir, NOW)
    expect(reasonsOf(result)).toEqual([text])
    expect(journalLines(journal)).toEqual([])
  })
})
