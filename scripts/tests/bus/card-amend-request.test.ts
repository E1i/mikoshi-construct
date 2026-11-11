import type { DatabaseSync } from 'node:sqlite'
import type { RequestTools } from '../../window/window-requests.js'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { riskLines, riskReading } from '../../../src/card/risk.js'
import { runAdmit } from '../../../src/commands/intake/admit.js'
import { BUS_DB_VARIABLE, openBus } from '../../core/db.js'
import { CARD_ADMITTED, CARD_MOVED, REQUEST_DONE, REQUEST_REFUSED } from '../../core/events.js'
import { reduce } from '../../core/reducer.js'
import { busCardAdmissions, busCardEvents, busHeldCards } from '../../intake/intake.js'
import { recordDecision } from '../../policy/decisions/index.js'
import { requestFromWindow, requestOf, WindowRequests } from '../../window/window-requests.js'

const NOW = new Date('2026-11-05T09:00:00.000Z')
const LANE = 'lane-3'
const STALE_RISK = 'risk: R1 — stale'
const TOUCH = 'src/board/run.ts'
const OTHER_TOUCH = 'src/board/tail.ts'
const roots: string[] = []

afterEach(() => {
  vi.unstubAllEnvs()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function witness(id: string): Record<string, unknown> {
  return { id, run: `pnpm exec vitest run tests/${id}.test.ts`, test: `the ${id} test`, head: 'pass', base: 'fail', proves: `what ${id} proves` }
}

function body(id: number, fields: unknown[] = [witness('W1'), witness('W2')]): string {
  return `card: #${id} amend-card [implement/runner/S/cheap/owner] · depends — · blocks —\nbranch: feat/card-${id}\ntouches: ${TOUCH}\ncontinue: stop\nwho: shift\n\nDo the thing.\n\n${STALE_RISK}\n\nwitnesses: ${JSON.stringify(fields)}\n`
}

interface World { db: DatabaseSync, repo: string, root: string }

function world(): World {
  const root = mkdtempSync(path.join(tmpdir(), 'card-amend-request-'))
  roots.push(root)
  const repo = path.join(root, 'repo')
  mkdirSync(path.join(repo, 'src', 'board'), { recursive: true })
  writeFileSync(path.join(repo, 'src', 'board', 'run.ts'), '')
  writeFileSync(path.join(repo, 'src', 'board', 'tail.ts'), '')
  mkdirSync(path.join(root, '.construct', 'parking'), { recursive: true })
  const bus = path.join(root, 'bus.db')
  vi.stubEnv(BUS_DB_VARIABLE, bus)
  vi.stubEnv('HOME', root)
  return { db: openBus(bus), repo, root }
}

function admitted(w: World, id: number, text: string = body(id)): void {
  const result = runAdmit({ file: path.join(w.root, `${id}.md`), body: text, dir: w.repo, dryRun: false, autoConfirm: true, events: busCardEvents(w.db), admissions: busCardAdmissions(w.db), cardStates: () => busHeldCards(w.db) }, () => NOW)
  expect(result.status).toBe('admitted')
  reduce(w.db)
}

function inLane(w: World, id: number): void {
  admitted(w, id)
  busCardEvents(w.db)({ type: CARD_MOVED, cardId: id, ts: NOW.toISOString(), dedupeKey: `${CARD_MOVED}:${id}:test`, payload: { lane: LANE, to: path.join(w.root, LANE) } })
  reduce(w.db)
}

function ownerAllows(w: World, cardId: number): void {
  recordDecision(w.db, { ts: NOW.toISOString(), decisionId: cardId, text: `[owner] разрешить понижение свидетеля #${cardId} W2`, cards: [cardId] })
  reduce(w.db)
}

function asked(w: World, request: Record<string, unknown>): { type: string, detail: string } {
  const id = requestFromWindow(w.db, NOW.toISOString(), 'test', { kind: 'amend', ...request })
  const tools = { closeDropped: () => [] } as unknown as RequestTools
  const later = new Date(NOW.getTime() + id * 1000)
  new WindowRequests(w.db, () => later, tools, path.join(w.root, 'channel'), () => null, w.repo, {} as never).run()
  reduce(w.db)
  const answer = w.db.prepare(`SELECT type, json_extract(payload, '$.detail') AS detail FROM events WHERE type IN (?, ?) AND json_extract(payload, '$.request') = ?`).get(REQUEST_DONE, REQUEST_REFUSED, id) as { type: string, detail: string }
  return answer
}

function latest(w: World, id: number): { text: string, lane: string, source: string } {
  return w.db.prepare(`SELECT json_extract(payload, '$.text') AS text, json_extract(payload, '$.lane') AS lane, json_extract(payload, '$.source') AS source FROM events WHERE type = ? AND card_id = ? ORDER BY id DESC LIMIT 1`).get(CARD_ADMITTED, id) as { text: string, lane: string, source: string }
}

function admissionCount(w: World, id: number): number {
  return Number((w.db.prepare('SELECT count(*) AS n FROM events WHERE type = ? AND card_id = ?').get(CARD_ADMITTED, id) as { n: number }).n)
}

describe('bus:request amend edits a card in the bus with no file', () => {
  it('a witness added by request keeps the lane, recomputes risk and writes no file', () => {
    const w = world()
    inLane(w, 80)
    expect(asked(w, { card: 80, add_witness: [JSON.stringify(witness('W3'))] })).toMatchObject({ type: REQUEST_DONE })
    const after = latest(w, 80)
    expect(after).toMatchObject({ lane: LANE, source: 'amend' })
    expect((w.db.prepare('SELECT lane FROM card_bodies WHERE card_id = 80').get() as { lane: string }).lane).toBe(LANE)
    expect(after.text).toContain('"id":"W3"')
    const [recomputed] = riskLines({ ...riskReading([TOUCH], false), slices: [], capabilityDelivery: false })
    expect(after.text).toContain(recomputed)
    expect(after.text).not.toContain(STALE_RISK)
    expect(readdirSync(path.join(w.root, '.construct', 'parking'))).toEqual([])
    expect(existsSync(path.join(w.root, '80.md'))).toBe(false)
    w.db.close()
  })

  it('each field operation edits the body in the bus', () => {
    const w = world()
    inLane(w, 80)
    admitted(w, 7)

    expect(asked(w, { card: 80, touches: `+${OTHER_TOUCH}` }).type).toBe(REQUEST_DONE)
    expect(latest(w, 80).text).toContain(`touches: ${TOUCH}, ${OTHER_TOUCH}\n`)
    expect(asked(w, { card: 80, touches: `-${OTHER_TOUCH}` }).type).toBe(REQUEST_DONE)
    expect(latest(w, 80).text).toContain(`touches: ${TOUCH}\n`)

    expect(asked(w, { card: 80, add_witness: [JSON.stringify(witness('W3'))] }).type).toBe(REQUEST_DONE)
    expect(latest(w, 80).text).toContain('"id":"W3"')
    expect(asked(w, { card: 80, remove_witness: ['W3'] }).type).toBe(REQUEST_REFUSED)
    expect(latest(w, 80).text).toContain('"id":"W3"')

    const words = 'дословно: правка без файла, "как есть"'
    expect(asked(w, { card: 80, owner_words: words }).type).toBe(REQUEST_DONE)
    expect(latest(w, 80).text).toContain(`Owner, verbatim: "${words}"`)

    expect(asked(w, { card: 80, depends: '+#7' }).type).toBe(REQUEST_DONE)
    expect(latest(w, 80).text).toContain('· depends #7 · blocks —')
    expect(asked(w, { card: 80, depends: '-#7' }).type).toBe(REQUEST_DONE)
    expect(latest(w, 80).text).toContain('· depends — · blocks —')
    expect(latest(w, 80).lane).toBe(LANE)

    const count = admissionCount(w, 80)
    for (const refused of [{ touches: '-src/board/gone.ts' }, { add_witness: [JSON.stringify(witness('W1'))] }, { add_witness: ['not json'] }, { remove_witness: ['W9'] }, { depends: '+7' }, {}])
      expect(asked(w, { card: 80, ...refused }).type).toBe(REQUEST_REFUSED)
    expect(asked(w, {}).type).toBe(REQUEST_REFUSED)
    expect(admissionCount(w, 80)).toBe(count)
    w.db.close()
  })

  it('removing a witness holds for the owner unless a decision allows it, and the last one is refused', () => {
    const w = world()
    inLane(w, 80)
    const held = asked(w, { card: 80, remove_witness: ['W2'] })
    expect(held.type).toBe(REQUEST_REFUSED)
    expect(held.detail).toContain('разрешить понижение свидетеля #80 W2')
    expect(latest(w, 80).text).toContain('"id":"W2"')
    ownerAllows(w, 80)
    expect(asked(w, { card: 80, remove_witness: ['W2'] }).type).toBe(REQUEST_DONE)
    expect(latest(w, 80).text).not.toContain('"id":"W2"')
    expect(asked(w, { card: 80, remove_witness: ['W1'] })).toMatchObject({ type: REQUEST_REFUSED, detail: expect.stringContaining('leaves the card no witness') })
    w.db.close()
  })

  it('a card with a witness list takes the same operations, by text or by W<n>', () => {
    const w = world()
    const prose = `card: #81 amend-card [implement/runner/S/cheap/owner] · depends — · blocks —\nbranch: feat/card-81\ntouches: ${TOUCH}\ncontinue: stop\nwho: shift\n\nDo the thing.\n\nWitnesses:\n- \`pnpm exec vitest run tests/a.test.ts\` exits 0; red on main\n`
    admitted(w, 81, prose)
    const added = '`pnpm exec vitest run tests/b.test.ts` exits 0; red on main'
    expect(asked(w, { card: 81, add_witness: [added] }).type).toBe(REQUEST_DONE)
    expect(latest(w, 81).text).toContain(`- ${added}\n`)
    expect(asked(w, { card: 81, add_witness: [added] }).type).toBe(REQUEST_REFUSED)
    ownerAllows(w, 81)
    expect(asked(w, { card: 81, remove_witness: ['W2'] }).type).toBe(REQUEST_DONE)
    expect(latest(w, 81).text).not.toContain(`- ${added}\n`)
    w.db.close()
  })

  it('a change of touches rewrites the runs line from the tests that cover them', () => {
    const w = world()
    mkdirSync(path.join(w.repo, 'scripts', 'tests', 'board'), { recursive: true })
    writeFileSync(path.join(w.repo, 'scripts', 'tests', 'board', 'tail.test.ts'), `import '../../../src/board/tail.js'\n`)
    inLane(w, 80)
    expect(asked(w, { card: 80, touches: `+${OTHER_TOUCH}` }).type).toBe(REQUEST_DONE)
    expect(latest(w, 80).text).toContain('runs: ["scripts/tests/board/tail.test.ts"]')
    expect(asked(w, { card: 80, touches: `-${OTHER_TOUCH}` }).type).toBe(REQUEST_DONE)
    expect(latest(w, 80).text).not.toContain('runs: ')
    w.db.close()
  })

  it('the request form takes every operation, and no card is no request', () => {
    expect(requestOf(['amend', '--touches', '+a'])).toBeNull()
    expect(requestOf(['amend', '--card', '80', '--touches', '+a', '+b', '--touches', '-c', '--add-witness', '{"id":"W3"}', '--add-witness', '{"id":"W4"}', '--remove-witness', 'W1', '--owner-words', 'as said', '--depends', '+#7,-#8', '--auto-confirm'])).toEqual({
      kind: 'amend',
      card: 80,
      touches: '+a,+b,-c',
      add_witness: ['{"id":"W3"}', '{"id":"W4"}'],
      remove_witness: ['W1'],
      owner_words: 'as said',
      depends: '+#7,-#8',
      auto_confirm: true,
    })
  })

  it('a priority set or cleared by request moves only the priority line', () => {
    const w = world()
    inLane(w, 80)
    expect(requestOf(['amend', '--card', '80', '--priority', 'p0'])).toEqual({ kind: 'amend', card: 80, priority: 'p0' })
    expect(asked(w, { card: 80, priority: 'p0' }).type).toBe(REQUEST_DONE)
    expect(latest(w, 80).text).toBe(body(80).replace('who: shift\n', 'who: shift\npriority: p0\n'))
    expect(asked(w, { card: 80, priority: 'none' }).type).toBe(REQUEST_DONE)
    expect(latest(w, 80).text).not.toContain('priority:')
    expect(asked(w, { card: 80, priority: 'p9' }).type).toBe(REQUEST_REFUSED)
    w.db.close()
  })
})
