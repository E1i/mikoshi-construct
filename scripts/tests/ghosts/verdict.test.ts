import type { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { readContourSchema, violations } from '../../contract/contours.js'
import { checkDisposition, checkVerdict, fetchVerdictFromRef, recordDisposition, recordVerdict } from '../../ghosts/verdict.js'

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

describe('verdict from a cloud branch', () => {
  it('a review verdict from a cloud branch is journaled the same as a local one', async () => {
    const local = handoff()
    const localVerdict = path.join(local.dir, 'review.verdict.json')
    write(localVerdict, local.good)
    await recordVerdict(localVerdict, local.dir, TARGET)

    const cloud = handoff()
    git(REPO, 'checkout', '-q', '-b', 'role/t-review')
    const roleDir = path.join(REPO, 'role', 't')
    mkdirSync(roleDir, { recursive: true })
    writeFileSync(path.join(roleDir, 'review-t.md'), REPORT)
    write(path.join(roleDir, 'review.verdict.json'), local.good)
    git(REPO, 'add', '-A')
    git(REPO, 'commit', '-q', '-m', 'role output')
    const fetched = fetchVerdictFromRef('role/t-review', REPO, 'role/t/review.verdict.json', cloud.dir)
    expect(fetched).toEqual({ ok: true, verdictPath: path.join(cloud.dir, 'review.verdict.json') })
    await recordVerdict(path.join(cloud.dir, 'review.verdict.json'), cloud.dir, TARGET)

    const [localLine] = journalLines(local.journal).map(line => JSON.parse(line) as Record<string, unknown>)
    const [cloudLine] = journalLines(cloud.journal).map(line => JSON.parse(line) as Record<string, unknown>)
    const { ts: _localTs, ...localRest } = localLine!
    const { ts: _cloudTs, ...cloudRest } = cloudLine!
    expect(cloudRest).toEqual(localRest)
    expect(cloudLine!.event).toBe('review')
  })

  it('refuses a ref that does not hold the verdict file', () => {
    const { dir } = handoff()
    const fetched = fetchVerdictFromRef('role/t-review', REPO, 'role/t/missing.json', dir)
    expect(fetched.ok).toBe(false)
  })

  it.each([
    { name: 'a ref that starts with a dash', ref: '--output=leak' },
    { name: 'an empty ref', ref: '' },
  ])('refuses $name and writes nothing', ({ ref }) => {
    const { dir } = handoff()
    const fetched = fetchVerdictFromRef(ref, REPO, 'role/t/review.verdict.json', dir)
    expect(fetched).toEqual({ ok: false, reasons: [`--from ${ref}: a ref is a name that does not start with "-"; nothing written`] })
    expect(existsSync(path.join(dir, 'review.verdict.json'))).toBe(false)
    expect(existsSync(path.join(process.cwd(), 'leak'))).toBe(false)
  })

  function roleBranch(name: string, reportPath: string): void {
    git(REPO, 'checkout', '-q', '-b', name)
    const roleDir = path.join(REPO, 'role', name)
    mkdirSync(roleDir, { recursive: true })
    writeFileSync(path.join(roleDir, 'review-t.md'), REPORT)
    const { good } = handoff()
    write(path.join(roleDir, 'review.verdict.json'), { ...good, report: { ...(good.report as object), path: reportPath } })
    git(REPO, 'add', '-A')
    git(REPO, 'commit', '-q', '-m', name)
  }

  it('refuses a report path with a directory part before any read, and creates nothing in the handoff dir', () => {
    roleBranch('nested-report', 'sub/review.md')
    const { dir } = handoff()
    const before = readdirSync(dir)
    const fetched = fetchVerdictFromRef('nested-report', REPO, 'role/nested-report/review.verdict.json', dir)
    expect(fetched).toEqual({ ok: false, reasons: ['--from nested-report: the report path sub/review.md has a directory part; the report lies beside the verdict file; nothing written'] })
    expect(readdirSync(dir)).toEqual(before)
  })

  it('refuses a verdict whose report.path is not a string, naming it', () => {
    roleBranch('numeric-report', 7 as unknown as string)
    const { dir } = handoff()
    expect(fetchVerdictFromRef('numeric-report', REPO, 'role/numeric-report/review.verdict.json', dir)).toEqual({ ok: false, reasons: ['--from numeric-report: the verdict\'s report.path is not a string; nothing written'] })
    expect(existsSync(path.join(dir, 'review.verdict.json'))).toBe(false)
  })

  it('refuses a report named like the verdict file or outside its directory, and writes nothing', () => {
    roleBranch('same-name', 'review.verdict.json')
    const first = handoff()
    expect(fetchVerdictFromRef('same-name', REPO, 'role/same-name/review.verdict.json', first.dir)).toEqual({ ok: false, reasons: ['--from same-name: the report review.verdict.json has the verdict file\'s name; nothing written'] })
    expect(existsSync(path.join(first.dir, 'review.verdict.json'))).toBe(false)

    roleBranch('other-case', 'Review.verdict.json')
    const cased = handoff()
    expect(fetchVerdictFromRef('other-case', REPO, 'role/other-case/review.verdict.json', cased.dir)).toEqual({ ok: false, reasons: ['--from other-case: the report Review.verdict.json has the verdict file\'s name; nothing written'] })

    roleBranch('up-a-level', '../review-t.md')
    const second = handoff()
    expect(fetchVerdictFromRef('up-a-level', REPO, 'role/up-a-level/review.verdict.json', second.dir)).toEqual({ ok: false, reasons: ['--from up-a-level: the report path ../review-t.md leaves the verdict\'s directory; nothing written'] })
    expect(existsSync(path.join(second.dir, 'review.verdict.json'))).toBe(false)
  })

  it('refuses to overwrite a file in the handoff directory that holds other bytes, and writes nothing', () => {
    roleBranch('occupied', 'review-t.md')
    const { dir } = handoff()
    writeFileSync(path.join(dir, 'review-t.md'), 'the window\'s own report\n')
    const fetched = fetchVerdictFromRef('occupied', REPO, 'role/occupied/review.verdict.json', dir)
    expect(fetched).toEqual({ ok: false, reasons: [`--from occupied: ${path.join(dir, 'review-t.md')} already holds other bytes; nothing written`] })
    expect(readFileSync(path.join(dir, 'review-t.md'), 'utf8')).toBe('the window\'s own report\n')
    expect(existsSync(path.join(dir, 'review.verdict.json'))).toBe(false)
  })

  it('refuses to write through a link planted in the handoff directory, and writes nothing', () => {
    roleBranch('linked', 'review-t.md')
    const { dir } = handoff()
    const outside = path.join(mkdtempSync(path.join(tmpdir(), 'ghosts-verdict-outside-')), 'written-through')
    rmSync(path.join(dir, 'review-t.md'))
    symlinkSync(outside, path.join(dir, 'review-t.md'))
    const fetched = fetchVerdictFromRef('linked', REPO, 'role/linked/review.verdict.json', dir)
    expect(fetched).toEqual({ ok: false, reasons: [`--from linked: ${path.join(dir, 'review-t.md')} is not a regular file; nothing written`] })
    expect(existsSync(outside)).toBe(false)
    expect(existsSync(path.join(dir, 'review.verdict.json'))).toBe(false)
  })
})
