import type { IntakeAdmission } from '../../bus/intake.js'
import type { JournalEvent } from '../../ghosts/approval.js'
import type { VerifiedClosing } from '../../ghosts/task-close.js'
import type { BusMerge } from '../../ghosts/task-merged.js'
import type { EvidenceDeps } from '../../release/evidence.js'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'vitest'
import { writtenBeforeHistoryEnds } from '../../../src/card/closed.js'
import { appendEvent, BUS_DB_VARIABLE, openBus } from '../../bus/db.js'
import { legacyEventOf } from '../../bus/import.js'
import { prClosed } from '../../bus/observations.js'
import { HANDOFF_DIR_VARIABLE } from '../../core/handoff-dir.js'
import { CARD_VERIFIED } from '../../ghosts/task-close.js'
import { runEvidence } from '../../release/evidence.js'

const BUS = '/construct/bus.db'
const JOURNAL = `${BUS} legacy line `
const SHIFT = '/shift/r1'
const COMMIT = 'a'.repeat(40)
const OUTSIDE = 'b'.repeat(40)
const CARD = { id: 7, name: 'seven', kind: 'implement', milestone: 'runner', size: 'XS', contour: 'cheap', decision: 'auto', depends: [], blocks: [], line: '#7 seven [implement/runner/XS/cheap/auto] · depends — · blocks —' }

const intake = { event: 'intake', task: '7', card: CARD.line, confirmation: 'none', corrections: [], ts: 't0' }
const merge = { event: 'merge', task: '7', pr: 70, by: 'E1i', commit: COMMIT, merged: '2026-10-07T00:00:00Z', ts: 't9' }

function world(journal: object[], files: Record<string, string> = {}, inBus: BusMerge[] = [], verified: VerifiedClosing[] = [], admissions: IntakeAdmission[] = []): EvidenceDeps {
  return { bus: BUS, read: file => files[file] ?? null, history: () => journal.filter(writtenBeforeHistoryEnds) as JournalEvent[], commits: () => new Set([COMMIT]), busMerges: () => inBus, verified: () => verified, admissions: () => admissions }
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
    expect(field(stdout, 'merge.shift')).toBe(`  merge.shift: unknown — no shift recorded on the start line in ${BUS}`)
    expect(field(stdout, 'budget')).toBe('  budget: gap — no budget is recorded apart from the forecast')
    expect(stdout.join('\n')).not.toMatch(/budget: (?!gap)/)
    expect(field(stdout, 'confirmation')).toBe(`  confirmation: none · corrections [] — ${JOURNAL}1`)
    expect(field(stdout, 'size')).toBe(`  size: XS — ${JOURNAL}2`)
    expect(field(stdout, 'result.merge')).toBe(`  result.merge: PR #70 by E1i at 2026-10-07T00:00:00Z — ${JOURNAL}3`)
  })

  it('after the cutoff the intake fields come from card.admitted in the bus', () => {
    const start = { event: 'path', task: '7', path: 'cheap', card: CARD, ts: '2026-10-13T00:00:01Z' }
    const admitted: IntakeAdmission = { task: '7', card: CARD.line, bodySha: 'abc', ts: '2026-10-13T00:00:00Z', confirmation: 'auto', source: 'admit', corrections: [], event: 12 }
    const { stdout } = runEvidence(['v1', 'v2'], world([start, merge], {}, [], [], [admitted]))

    expect(field(stdout, 'confirmation')).toBe(`  confirmation: auto · corrections [] — ${BUS} event 12`)
  })

  it('after the cutoff a journal intake line with no card.admitted in the bus gives no intake fields', () => {
    const start = { event: 'path', task: '7', path: 'cheap', card: CARD, ts: '2026-10-13T00:00:01Z' }
    const { stdout } = runEvidence(['v1', 'v2'], world([{ ...intake, ts: '2026-10-13T00:00:00Z' }, start, merge]))

    expect(field(stdout, 'confirmation')).toMatch(/^ {2}confirmation: unknown — /)
  })

  it('risk comes only from the recorded risk', () => {
    const bare = { event: 'path', task: '7', path: 'cheap', card: { ...CARD, size: 'L', contour: 'ladder' }, ts: 't1' }
    expect(field(runEvidence(['v1', 'v2'], world([intake, bare, merge])).stdout, 'risk')).toMatch(/^ {2}risk: unknown — /)

    const risk = { level: 'R3', text: 'R3 — moderate: written on the card' }
    const recorded = { ...bare, risk }
    expect(field(runEvidence(['v1', 'v2'], world([intake, recorded, merge])).stdout, 'risk')).toBe(`  risk: ${risk.text} — ${JOURNAL}2`)
  })

  it('prints every recorded field with the line it came from, the forecast apart from the budget', () => {
    const start = { event: 'path', task: '7', path: 'cheap', card: CARD, who: 'shift', shift: SHIFT, forecast: { tokens: 67000, minutes: 4.4, class: 'implement/XS', n: 31 }, ts: 't1' }
    const close = { event: 'path', task: '7', path: 'cheap', pr: 70, verification: 'run', actual: { tokens: 84685, minutes: null }, ts: 't2' }
    const stop = { event: 'stop', task: '7', at: 'merge', ts: 't3' }
    const review = { event: 'review', task: '7', verdict: 'accept', ts: 't4' }
    const shiftLine = { event: 'task', task: '7', merge: ['[shift:merge] decision auto, no owner path — auto-merge armed on PR #70 at abc'] }
    const deps = world([intake, start, close, stop, review, merge], { [`${SHIFT}/shift.jsonl`]: `{"event":"start"}\n${JSON.stringify(shiftLine)}` })

    const { stdout } = runEvidence(['v1', 'v2'], deps)

    expect(field(stdout, 'who')).toBe(`  who: shift — ${JOURNAL}2`)
    expect(field(stdout, 'contour')).toBe(`  contour: cheap — ${JOURNAL}2`)
    expect(field(stdout, 'merge.decision')).toBe(`  merge.decision: auto — ${JOURNAL}2`)
    expect(field(stdout, 'merge.shift')).toBe(`  merge.shift: ${shiftLine.merge[0]} — ${SHIFT}/shift.jsonl:2`)
    expect(field(stdout, 'forecast')).toBe(`  forecast: tokens ≈ 67000, minutes ≈ 4.4 — class implement/XS, n=31 — ${JOURNAL}2`)
    expect(field(stdout, 'budget')).toBe('  budget: gap — no budget is recorded apart from the forecast')
    expect(field(stdout, 'actual')).toBe(`  actual: tokens 84685, minutes unknown — ${JOURNAL}3`)
    expect(field(stdout, 'result.verification')).toBe(`  result.verification: run — ${JOURNAL}3`)
    expect(field(stdout, 'result.stop')).toBe(`  result.stop: merge — ${JOURNAL}4`)
    expect(field(stdout, 'result.review')).toBe(`  result.review: accept — ${JOURNAL}5`)
  })

  it('leaves out a merge line whose commit is outside the range', () => {
    const { stdout } = runEvidence(['v1', 'v2'], world([intake, { ...merge, commit: OUTSIDE }]))

    expect(stdout).toEqual([`no merge line in ${BUS} legacy history and no merged pr.closed in ${BUS} has a commit in v1..v2`])
  })

  it('refuses without exactly two revisions', () => {
    expect(runEvidence(['v1'], world([])).exitCode).toBe(1)
  })

  it('a merge after the cutoff comes from pr.closed in the bus with no merge line in the journal', () => {
    const start = { event: 'path', task: '7', path: 'cheap', card: CARD, ts: '2026-10-13T10:00:00.000Z' }
    const inBus: BusMerge[] = [
      { task: '7', pr: 70, by: 'E1i', commit: COMMIT, merged: '2026-10-13T11:00:00Z', event: 11133264 },
      { task: '8', pr: 80, by: 'E1i', commit: OUTSIDE, merged: '2026-10-13T11:05:00Z', event: 11133265 },
    ]
    const { stdout } = runEvidence(['v1', 'v2'], world([intake, start], {}, inBus))
    expect(stdout.filter(line => line.startsWith('#'))).toEqual([`#7 · PR #70 · commit ${COMMIT.slice(0, 7)}`])
    expect(field(stdout, 'result.merge')).toBe(`  result.merge: PR #70 by E1i at 2026-10-13T11:00:00Z — ${BUS} event 11133264`)
    expect(field(stdout, 'size')).toBe(`  size: XS — ${JOURNAL}1`)
  })

  it('a journal merge line written after the cutoff is not read', () => {
    const late = { ...merge, ts: '2026-10-12T17:04:00.000Z' }
    const early = { ...merge, task: '6', pr: 60, ts: '2026-10-12T17:03:59.999Z' }
    const inBus: BusMerge[] = [{ task: '7', pr: 70, by: 'E1i', commit: COMMIT, merged: '2026-10-13T11:00:00Z', event: 11133264 }]
    const { stdout } = runEvidence(['v1', 'v2'], world([intake, early, late], {}, inBus))
    expect(stdout.filter(line => line.startsWith('#'))).toEqual([`#6 · PR #60 · commit ${COMMIT.slice(0, 7)}`, `#7 · PR #70 · commit ${COMMIT.slice(0, 7)}`])
    expect(stdout.filter(line => line.startsWith('  result.merge: ')).map(line => line.split(' — ')[1])).toEqual([`${JOURNAL}2`, `${BUS} event 11133264`])
  })

  it('a closing after the cutoff comes from card.verified in the bus, and a journal path line written after the cutoff is not read', () => {
    const start = { event: 'path', task: '7', path: 'cheap', card: CARD, ts: '2026-10-13T10:00:00.000Z' }
    const lateClosing = { event: 'path', task: '7', path: 'cheap', pr: 70, verification: 'review', actual: { tokens: 1, minutes: 1 }, ts: '2026-10-13T10:30:00.000Z' }
    const inBus: BusMerge[] = [{ task: '7', pr: 70, by: 'E1i', commit: COMMIT, merged: '2026-10-13T11:00:00Z', event: 11133264 }]
    const verified: VerifiedClosing[] = [
      { task: '7', pr: 70, verification: 'run', actual: { tokens: 1200, minutes: 30 }, event: 11133270 },
      { task: '8', pr: 80, verification: 'review', actual: { tokens: 9, minutes: 9 }, event: 11133271 },
    ]
    const { stdout } = runEvidence(['v1', 'v2'], world([intake, start, lateClosing], {}, inBus, verified))
    expect(field(stdout, 'result.verification')).toBe(`  result.verification: run — ${BUS} event 11133270`)
    expect(field(stdout, 'actual')).toBe(`  actual: tokens 1200, minutes 30 — ${BUS} event 11133270`)
    const withoutBus = runEvidence(['v1', 'v2'], world([intake, start, lateClosing], {}, inBus)).stdout
    expect(field(withoutBus, 'result.verification')).toMatch(/^ {2}result\.verification: unknown — /)
  })

  it('the release:evidence script shows the verification task:close wrote to the bus as card.verified, not unknown', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'release-evidence-verified-'))
    try {
      const git = (...args: string[]): string => execFileSync('git', ['-C', root, '-c', 'user.name=world', '-c', 'user.email=world@example.invalid', ...args], { encoding: 'utf8' }).trim()
      git('init', '-q')
      git('commit', '-q', '--allow-empty', '-m', 'from')
      git('commit', '-q', '--allow-empty', '-m', 'to')
      const to = git('rev-parse', 'HEAD')
      const handoff = path.join(root, 'handoff')
      mkdirSync(handoff)
      writeFileSync(path.join(handoff, 'ghosts.jsonl'), `${JSON.stringify(intake)}\n`)
      const bus = path.join(root, 'bus.db')
      const db = openBus(bus)
      appendEvent(db, prClosed('2026-10-13T11:00:01.000Z', { pr: 70, cardId: 7, merged: true, commit: to, mergedBy: 'E1i', mergedAt: '2026-10-13T11:00:00Z' }))
      appendEvent(db, { ts: '2026-10-13T11:10:00.000Z', type: CARD_VERIFIED, actor: 'worker:task-close:by-hand', cardId: 7, pr: 70, head: null, dedupeKey: `${CARD_VERIFIED}:7:2026-10-13T11:10:00.000Z`, payload: { path: 'cheap', pr: 70, verification: 'run', ended: '2026-10-13T11:10:00.000Z', sessions: [], actual: { tokens: 1200, minutes: 30 } }, legacy: false })
      db.close()
      const result = spawnSync(process.execPath, [path.resolve(import.meta.dirname, '../../../node_modules/tsx/dist/cli.mjs'), path.resolve(import.meta.dirname, '../../release/evidence.ts'), 'HEAD~1', 'HEAD'], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, [BUS_DB_VARIABLE]: bus, [HANDOFF_DIR_VARIABLE]: handoff },
      })
      expect(result.stderr).toBe('')
      expect(result.stdout).toContain(`  result.verification: run — ${bus} event 2`)
      expect(result.stdout).toContain(`  actual: tokens 1200, minutes 30 — ${bus} event 2`)
    }
    finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('with an empty handoff directory the evidence of a range merged before the cutoff has the values the journal gave', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'release-evidence-legacy-'))
    try {
      const git = (...args: string[]): string => execFileSync('git', ['-C', root, '-c', 'user.name=world', '-c', 'user.email=world@example.invalid', ...args], { encoding: 'utf8' }).trim()
      git('init', '-q')
      git('commit', '-q', '--allow-empty', '-m', 'from')
      git('commit', '-q', '--allow-empty', '-m', 'to')
      const to = git('rev-parse', 'HEAD')
      const handoff = path.join(root, 'handoff')
      mkdirSync(handoff)
      const bus = path.join(root, 'bus.db')
      const db = openBus(bus)
      const lines = [
        { ...intake, ts: '2026-10-01T00:00:00.000Z' },
        { event: 'path', task: '7', path: 'cheap', card: CARD, who: 'shift', ts: '2026-10-01T00:00:01.000Z' },
        { event: 'stop', task: '7', at: 'merge', ts: '2026-10-01T00:00:02.000Z' },
        { event: 'review', task: '7', verdict: 'accept', ts: '2026-10-01T00:00:03.000Z' },
        { ...merge, commit: to, ts: '2026-10-01T00:00:04.000Z' },
      ]
      lines.forEach((line, index) => {
        const event = legacyEventOf(JSON.stringify(line), index + 1)
        if (event !== null)
          appendEvent(db, event)
      })
      db.close()
      const result = spawnSync(process.execPath, [path.resolve(import.meta.dirname, '../../../node_modules/tsx/dist/cli.mjs'), path.resolve(import.meta.dirname, '../../release/evidence.ts'), 'HEAD~1', 'HEAD'], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, [BUS_DB_VARIABLE]: bus, [HANDOFF_DIR_VARIABLE]: handoff },
      })
      expect(result.stderr).toBe('')
      expect(field(result.stdout.split('\n'), 'who')).toMatch(/^ {2}who: shift — /)
      expect(field(result.stdout.split('\n'), 'confirmation')).toMatch(/^ {2}confirmation: none · corrections \[\] — /)
      expect(field(result.stdout.split('\n'), 'result.stop')).toMatch(/^ {2}result\.stop: merge — /)
      expect(field(result.stdout.split('\n'), 'result.review')).toMatch(/^ {2}result\.review: accept — /)
      expect(field(result.stdout.split('\n'), 'result.merge')).toMatch(/^ {2}result\.merge: PR #70 by E1i at 2026-10-07T00:00:00Z — /)
    }
    finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('with no ghosts.jsonl the evidence exits 0', () => {
    const { exitCode, stderr } = runEvidence(['v1', 'v2'], { ...world([]), read: () => null })

    expect(exitCode).toBe(0)
    expect(stderr).toEqual([])
  })

  it('the release:evidence script reads the bus it is given', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'release-evidence-bus-'))
    try {
      const git = (...args: string[]): string => execFileSync('git', ['-C', root, '-c', 'user.name=world', '-c', 'user.email=world@example.invalid', ...args], { encoding: 'utf8' }).trim()
      git('init', '-q')
      git('commit', '-q', '--allow-empty', '-m', 'from')
      git('commit', '-q', '--allow-empty', '-m', 'to')
      const to = git('rev-parse', 'HEAD')
      const handoff = path.join(root, 'handoff')
      mkdirSync(handoff)
      writeFileSync(path.join(handoff, 'ghosts.jsonl'), `${JSON.stringify(intake)}\n`)
      const bus = path.join(root, 'bus.db')
      const db = openBus(bus)
      appendEvent(db, prClosed('2026-10-13T11:00:01.000Z', { pr: 70, cardId: 7, merged: true, commit: to, mergedBy: 'E1i', mergedAt: '2026-10-13T11:00:00Z' }))
      db.close()
      const result = spawnSync(process.execPath, [path.resolve(import.meta.dirname, '../../../node_modules/tsx/dist/cli.mjs'), path.resolve(import.meta.dirname, '../../release/evidence.ts'), 'HEAD~1', 'HEAD'], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, [BUS_DB_VARIABLE]: bus, [HANDOFF_DIR_VARIABLE]: handoff },
      })
      expect(result.stderr).toBe('')
      expect(result.stdout).toContain(`  result.merge: PR #70 by E1i at 2026-10-13T11:00:00Z — ${bus} event 1`)
    }
    finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
