import type { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appendEvent, openBus } from '../../core/db.js'
import { PR_OBSERVED, PR_OPENED } from '../../core/events.js'
import { requestDecision, requestFromOwnerShell, roundLimitHeadRefusal } from '../../policy/decisions/add.js'
import { continueFixesDecisionOf, roundLimitDecisionOf } from '../../policy/round-limit-decision.js'
import { pendingRequests } from '../../window/window-requests.js'

const NOW = new Date('2026-11-09T10:00:00.000Z')
const PR = 1475
const HEAD = `d624d0a8${'1'.repeat(32)}`
const OTHER_HEAD = `d624d0a8${'2'.repeat(32)}`
const LATER_HEAD = 'e'.repeat(40)
const roots: string[] = []
const opened: DatabaseSync[] = []

afterEach(() => {
  for (const db of opened.splice(0))
    db.close()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function bus(heads: readonly string[]): DatabaseSync {
  const root = mkdtempSync(path.join(tmpdir(), 'round-limit-short-sha-'))
  roots.push(root)
  const db = openBus(path.join(root, 'bus.db'))
  opened.push(db)
  heads.forEach((head, at) => appendEvent(db, { ts: NOW.toISOString(), type: at === 0 ? PR_OPENED : PR_OBSERVED, actor: 'worker:shift:1', cardId: 1737, pr: PR, head, dedupeKey: `head:${PR}:${at}`, payload: { pr: PR }, legacy: false }))
  return db
}

function request(db: DatabaseSync, text: string): { code: number, out: string[] } {
  const out: string[] = []
  const code = requestDecision(['--from', 'answer', '--card', '#1737', text], db, NOW, 'window-1', line => out.push(line))
  return { code, out }
}

describe('decisions:add and the head a round-limit decision names', () => {
  it('decisions add refuses a continue-fixes record whose sha is not a full head of the PR', () => {
    const db = bus([HEAD, LATER_HEAD])
    const refused = request(db, `[owner] continue-fixes PR #${PR} at d624d0a8`)
    expect(refused.code).toBe(1)
    expect(refused.out.join('\n')).toContain(`the full head is ${HEAD}: write "[owner] continue-fixes PR #${PR} at ${HEAD}"`)
    expect(refused.out.join('\n')).toContain('nothing requested')
    expect(pendingRequests(db)).toEqual([])
    expect(continueFixesDecisionOf([{ decisionId: 411, text: `[owner] continue-fixes PR #${PR} at d624d0a8`, cards: [] }], PR, HEAD, [])).toBeNull()
  })

  it('a continue-fixes record with the full head is accepted and found by continueFixesDecisionOf', () => {
    const db = bus([HEAD, LATER_HEAD])
    const text = `[owner] continue-fixes PR #${PR} at ${HEAD}`
    const accepted = request(db, text)
    expect(accepted.code, accepted.out.join('\n')).toBe(0)
    expect(pendingRequests(db)).toHaveLength(1)
    expect(continueFixesDecisionOf([{ decisionId: 411, text, cards: [1737] }], PR, HEAD, [])).toBe(411)
  })

  it('refuses an allow-merge record at a short sha and accepts it at the full head', () => {
    const db = bus([HEAD])
    expect(request(db, `[owner] allow-merge PR #${PR} at d624d0a`).code).toBe(1)
    const text = `[owner] allow-merge PR #${PR} at ${HEAD}`
    expect(request(db, text).code).toBe(0)
    expect(roundLimitDecisionOf([{ decisionId: 9, text, cards: [] }], PR, HEAD, [])).toBe(9)
  })

  it('refuses a full sha the bus never observed for the PR, naming the latest head', () => {
    const refusal = roundLimitHeadRefusal(`[owner] continue-fixes PR #${PR} at ${'a'.repeat(40)}`, () => [HEAD, LATER_HEAD])
    expect(refusal).toContain(`the latest observed head of PR #${PR} is ${LATER_HEAD}`)
  })

  it('names no full head when the short form is the prefix of more than one, or when no head was observed', () => {
    expect(roundLimitHeadRefusal(`continue-fixes PR #${PR} at d624d0a8`, () => [HEAD, OTHER_HEAD])).toContain(`2 observed heads of PR #${PR} start with d624d0a8`)
    expect(roundLimitHeadRefusal(`continue-fixes PR #${PR} at d624d0a8`, () => [])).toContain(`the bus observed no head of PR #${PR}`)
  })

  it('names the lower-case head for an upper-case sha, which the bus does not read', () => {
    expect(roundLimitHeadRefusal(`[owner] continue-fixes PR #${PR} at D624D0A8`, () => [HEAD])).toContain(`the full head is ${HEAD}`)
  })

  it('leaves a record that is neither allow-merge nor continue-fixes to the rest of decisions:add', () => {
    for (const text of [`[owner] look at PR #${PR} at d624d0a8`, '[owner] merge the version pull request.', `[owner] continue-fixes PR #${PR}`])
      expect(roundLimitHeadRefusal(text, () => [])).toBeNull()
  })

  it('refuses from the owner shell before the text reaches the owner channel', () => {
    const db = bus([HEAD])
    const root = mkdtempSync(path.join(tmpdir(), 'round-limit-channel-'))
    roots.push(root)
    const err: string[] = []
    expect(requestFromOwnerShell([`[owner] continue-fixes PR #${PR} at d624d0a8`], path.join(root, 'channel'), db, NOW, () => {}, line => err.push(line))).toBe(1)
    expect(err.join('\n')).toContain(`the full head is ${HEAD}`)
    expect(pendingRequests(db)).toEqual([])
  })
})
