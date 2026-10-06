import type { BuildRunner } from '../../ghosts/hash.js'
import type { Preflight } from '../../ghosts/preflight.js'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { parkingFileText } from '../../../src/card/parking.js'
import { revokeEvent } from '../../ghosts/approval.js'
import { approveArgs, approveCard, renderWaiting, revokeCard, waitingBriefs } from '../../ghosts/approve.js'
import { hashBrief } from '../../ghosts/hash.js'

const NOW = new Date(2026, 9, 6, 12)
const OWNER = 'Owner'
const R1_TOUCH = 'scripts/ghosts/launch.ts'
const R3_TOUCH = 'package.json'
const EXPECT_LINE = 'expect: tokens ≈ 166k, minutes ≈ 12 — effort medium, n=61, median, p25–p75 100k–200k'
const RED_TABLE = ['| W | rc | reason on the base | halves the base cannot fail |', '|---|---|---|---|', '| W1 | 1 | no such test | none |']

interface Brief {
  card: number
  touches?: string
  expectLine?: string | null
  redOnBase?: boolean
  approvedBy?: string
}

function cardLine(card: number): string {
  return `#${card} task-${card} [implement/ghosts/S/ladder/owner] · depends — · blocks —`
}

function briefContent(brief: Brief): string {
  const implement = [`/implement Print the name of card ${brief.card}.`, 'Sketch: none — independent implementation is the witness', ...(brief.expectLine === null ? [] : [brief.expectLine ?? EXPECT_LINE]), '', 'Acceptance: the name is printed — witness: `echo name`']
  const red = brief.redOnBase === false ? [] : ['Red on base (run at abc1234):', '', ...RED_TABLE, '']
  return [`# brief ${brief.card}`, '', ...red, '---', '', ...implement, ''].join('\n')
}

function world(briefs: Brief[]): { handoff: string, parking: string, journal: string, briefPath: (card: number) => string } {
  const root = mkdtempSync(path.join(tmpdir(), 'ghosts-approve-'))
  const handoff = path.join(root, 'handoff')
  const parking = path.join(root, 'parking')
  mkdirSync(handoff)
  mkdirSync(parking)
  const briefPath = (card: number): string => path.join(handoff, `brief-${card}.md`)
  for (const brief of briefs) {
    writeFileSync(briefPath(brief.card), briefContent(brief))
    writeFileSync(path.join(parking, `${brief.card}.md`), parkingFileText({ card: cardLine(brief.card), branch: `feat/${brief.card}`, touches: [brief.touches ?? R1_TOUCH], continue: 'stop', who: 'shift', body: 'Do the thing.' }))
    if (brief.approvedBy !== undefined)
      writeFileSync(briefPath(brief.card).replace(/\.md$/, '.approved-sha256'), `approved /implement text sha256: ${hashBrief(briefPath(brief.card))} sketch: none (2026-10-05, ${brief.approvedBy})\n`)
  }
  const tasks = briefs.map(brief => ({ id: `t-${brief.card}`, brief: briefPath(brief.card), card: cardLine(brief.card) }))
  writeFileSync(path.join(handoff, 'tasks-batch.json'), JSON.stringify({ repo: root, status: path.join(handoff, 'status.md'), out: handoff, tasks }))
  return { handoff, parking, journal: path.join(handoff, 'ghosts.jsonl'), briefPath }
}

function journalLines(journal: string): Record<string, unknown>[] {
  return existsSync(journal) ? readFileSync(journal, 'utf8').trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>) : []
}

function green(): { runBuild: ReturnType<typeof vi.fn<BuildRunner>>, preflight: ReturnType<typeof vi.fn<Preflight>> } {
  return { runBuild: vi.fn<BuildRunner>(() => ({ status: 0, stderr: '' })), preflight: vi.fn<Preflight>() }
}

describe('pnpm approve', () => {
  it('lists briefs waiting for the owner: card, risk and why R1, hash, forecast, brief and red-on-base table', () => {
    const w = world([{ card: 701 }])
    const waiting = waitingBriefs(w.handoff, w.parking)
    expect(waiting.map(entry => entry.card.id)).toEqual([701])
    const lines = renderWaiting(waiting)
    expect(lines[0]).toBe(cardLine(701))
    expect(lines).toContain(`  risk: R1 — the ladder mechanism a task runs on: ${R1_TOUCH}`)
    expect(lines).toContain(`  sha256: ${hashBrief(w.briefPath(701))}`)
    expect(lines).toContain(`  ${EXPECT_LINE}`)
    expect(lines).toContain(`  brief: ${w.briefPath(701)}`)
    expect(lines.slice(-RED_TABLE.length - 1)).toEqual(['  red on base:', ...RED_TABLE.map(line => `  ${line}`)])
  })

  it('lists briefs waiting for the owner without those MORSE may approve or the owner already approved', () => {
    const w = world([{ card: 701 }, { card: 702, touches: R3_TOUCH }, { card: 703, approvedBy: OWNER }])
    expect(waitingBriefs(w.handoff, w.parking).map(entry => entry.card.id)).toEqual([701])
  })

  it('lists briefs waiting for the owner whose card cannot be read or whose approval was revoked', () => {
    const w = world([{ card: 701, approvedBy: OWNER }, { card: 702, touches: R3_TOUCH }])
    writeFileSync(w.journal, `${JSON.stringify(revokeEvent(hashBrief(w.briefPath(701)), 701, NOW.toISOString()))}\n`)
    const unparked = path.join(w.parking, 'none')
    mkdirSync(unparked)
    const waiting = waitingBriefs(w.handoff, unparked)
    expect(waiting.map(entry => [entry.card.id, entry.risk])).toEqual([[701, 'not read'], [702, 'not read']])
  })

  it('lists briefs waiting for the owner and names a missing forecast and red-on-base table', () => {
    const w = world([{ card: 701, expectLine: null, redOnBase: false }])
    const lines = renderWaiting(waitingBriefs(w.handoff, w.parking))
    expect(lines).toContain(`  expect not recorded in ${w.briefPath(701)}`)
    expect(lines).toContain(`  red on base: not in ${w.briefPath(701)}`)
  })

  it('lists briefs waiting for the owner as none when the queue is empty', () => {
    const w = world([{ card: 701, approvedBy: OWNER }])
    expect(renderWaiting(waitingBriefs(w.handoff, w.parking))).toEqual(['no brief waits for the owner'])
  })

  it('approves by card number: the approval line in .approved-sha256 and an approval event by the owner', async () => {
    const w = world([{ card: 701 }])
    const { runBuild, preflight } = green()
    const sha256 = hashBrief(w.briefPath(701))
    const line = await approveCard(701, { handoffDir: w.handoff, now: NOW, approver: OWNER, runBuild, preflight })
    expect(line).toBe(`approved /implement text sha256: ${sha256} sketch: none (2026-10-06, ${OWNER})`)
    expect(readFileSync(w.briefPath(701).replace(/\.md$/, '.approved-sha256'), 'utf8')).toBe(`${line}\n`)
    expect(journalLines(w.journal)).toEqual([{ event: 'approval', by: OWNER, card: 701, brief: w.briefPath(701), sha256, sketch: 'none', ts: NOW.toISOString() }])
    expect(preflight).toHaveBeenCalledOnce()
    expect(waitingBriefs(w.handoff, w.parking)).toEqual([])
  })

  it('approves by card number with or without the # and refuses anything else', () => {
    expect(approveArgs(['#701'])).toEqual({ kind: 'approve', card: 701, by: undefined })
    expect(approveArgs(['701', '--by', OWNER])).toEqual({ kind: 'approve', card: 701, by: OWNER })
    expect(approveArgs([])).toEqual({ kind: 'list' })
    expect(() => approveArgs(['brief-701.md'])).toThrow(/expected a card number/)
    expect(() => approveArgs(['701', '--by'])).toThrow(/usage/)
  })

  it('approves by card number only for a card a tasks file names, and not as morse', async () => {
    const w = world([{ card: 701 }])
    const { runBuild, preflight } = green()
    await expect(approveCard(799, { handoffDir: w.handoff, now: NOW, approver: OWNER, runBuild, preflight })).rejects.toThrow(/no tasks file .* names card #799/)
    await expect(approveCard(701, { handoffDir: w.handoff, now: NOW, approver: 'Morse', runBuild, preflight })).rejects.toThrow(/owner's approval/)
    expect(existsSync(w.journal)).toBe(false)
  })

  it('approves by card number nothing when the build fails, the hash is approved or was revoked', async () => {
    const w = world([{ card: 701 }, { card: 702, approvedBy: OWNER }, { card: 703 }])
    writeFileSync(w.journal, `${JSON.stringify(revokeEvent(hashBrief(w.briefPath(703)), 703, NOW.toISOString()))}\n`)
    const red = vi.fn<BuildRunner>(() => ({ status: 1, stderr: 'no witness\n' }))
    const options = { handoffDir: w.handoff, now: NOW, approver: OWNER, runBuild: red, preflight: vi.fn<Preflight>() }
    await expect(approveCard(701, options)).rejects.toThrow(/check-acceptance build exited 1/)
    await expect(approveCard(702, options)).rejects.toThrow(/already holds this hash/)
    await expect(approveCard(703, options)).rejects.toThrow(/was revoked/)
    expect(existsSync(w.briefPath(701).replace(/\.md$/, '.approved-sha256'))).toBe(false)
    expect(journalLines(w.journal)).toHaveLength(1)
  })

  it('revokes the approved hash of a card in the journal and the brief waits again', async () => {
    const w = world([{ card: 701, approvedBy: OWNER }])
    const sha256 = hashBrief(w.briefPath(701))
    expect(await revokeCard(701, w.handoff, NOW)).toBe(`card #701: approval ${sha256.slice(0, 7)} revoked in ${w.journal}`)
    expect(journalLines(w.journal)).toEqual([{ event: 'revoke', sha256, card: 701, ts: NOW.toISOString() }])
    expect(waitingBriefs(w.handoff, w.parking).map(entry => entry.card.id)).toEqual([701])
    expect(approveArgs(['--revoke', '#701'])).toEqual({ kind: 'revoke', card: 701 })
  })

  it('revokes nothing for a card with no approval or one already revoked', async () => {
    const w = world([{ card: 701 }, { card: 702, approvedBy: OWNER }])
    await expect(revokeCard(701, w.handoff, NOW)).rejects.toThrow(/nothing is revoked/)
    await revokeCard(702, w.handoff, NOW)
    await expect(revokeCard(702, w.handoff, NOW)).rejects.toThrow(/already revoked/)
    expect(journalLines(w.journal)).toHaveLength(1)
  })
})
