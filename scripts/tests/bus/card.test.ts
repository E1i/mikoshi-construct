import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runAdmit } from '../../../src/commands/intake/admit.js'
import { CARD_ADMITTED } from '../../../src/commands/intake/index.js'
import { WINDOW_LANE } from '../../bus/card-bodies.js'
import { CONTRACT_FIELDS, CONTRACTS } from '../../bus/card-contract.js'
import { runCard } from '../../bus/card.js'
import { BUS_DB_VARIABLE, openBus } from '../../bus/db.js'
import { busIntakePorts } from '../../bus/intake.js'
import { reduce } from '../../bus/reducer.js'

const AFTER_THE_CUTOFF = new Date('2026-10-13T09:00:00.000Z')
const CARD = '#90 contract-card [implement/netwatch/S/cheap/auto] · depends — · blocks —'
const BODY = [
  'Do the thing.',
  '',
  'Path (D-76): cheap, set by the owner.',
  '',
  'Witnesses:',
  '- `pnpm exec vitest run scripts/tests/a.test.ts` exits 0',
  '',
  'risk: R3 — moderate: src/a.ts',
].join('\n')
const roots: string[] = []

afterEach(() => {
  vi.unstubAllEnvs()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

interface Ran { code: number, out: string, err: string[] }

function busWithAdmittedCard(): { bus: string, text: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'card-cli-'))
  roots.push(root)
  const repo = path.join(root, 'repo')
  mkdirSync(path.join(repo, 'src'), { recursive: true })
  writeFileSync(path.join(repo, 'src', 'a.ts'), '')
  const parking = path.join(root, 'parking')
  mkdirSync(path.join(parking, 'lane-7'), { recursive: true })
  const file = path.join(parking, 'lane-7', '90.md')
  writeFileSync(file, `card: ${CARD}\nbranch: feat/contract-card\ntouches: src/a.ts\ncontinue: stop\nwho: shift\n\n${BODY}\n`)
  const bus = path.join(root, 'bus.db')
  vi.stubEnv(BUS_DB_VARIABLE, bus)
  const db = openBus(bus)
  try {
    const ports = busIntakePorts(db, 's1')
    runAdmit({ file, dir: repo, journal: path.join(root, 'ghosts.jsonl'), dryRun: false, autoConfirm: false, parkingRoot: parking, events: ports.cardEvents, cardStates: ports.cardStates, admissions: ports.cardAdmissions }, () => AFTER_THE_CUTOFF)
    reduce(db)
  }
  finally {
    db.close()
  }
  return { bus, text: readFileSync(file, 'utf8') }
}

function run(bus: string, args: string[]): Ran {
  const out: string[] = []
  const err: string[] = []
  const code = runCard(args, { bus, out: text => out.push(text), err: line => err.push(line) })
  return { code, out: out.join(''), err }
}

function admittedTextSha(bus: string): unknown {
  const db = openBus(bus)
  try {
    const row = db.prepare(`SELECT payload FROM events WHERE type = '${CARD_ADMITTED}'`).get() as { payload: string }
    return (JSON.parse(row.payload) as { textSha: unknown }).textSha
  }
  finally {
    db.close()
  }
}

describe('pnpm card reads a card from card_bodies', () => {
  it('card --contract start prints exactly the start contract fields', () => {
    const { bus, text } = busWithAdmittedCard()
    const ran = run(bus, ['90', '--contract', 'start'])
    expect(ran.code).toBe(0)
    const printed = JSON.parse(ran.out) as Record<string, unknown>
    expect(Object.keys(printed)).toEqual([...CONTRACT_FIELDS.start])
    expect(printed).toEqual({
      id: 90,
      name: 'contract-card',
      cardLine: CARD,
      branch: 'feat/contract-card',
      contour: 'cheap',
      path: 'cheap, set by the owner.',
      touches: ['src/a.ts'],
      who: 'shift',
      risk: 'R3 — moderate: src/a.ts',
      lane: WINDOW_LANE,
      textSha: createHash('sha256').update(text).digest('hex'),
      lastHeartbeat: null,
    })
  })

  it('card --md prints the admitted text, whose sha is the admission textSha', () => {
    const { bus, text } = busWithAdmittedCard()
    const ran = run(bus, ['#90', '--md'])
    expect(ran).toEqual({ code: 0, out: text, err: [] })
    expect(createHash('sha256').update(ran.out).digest('hex')).toBe(admittedTextSha(bus))
  })

  it('card --chain prints the chain of the admitted card as JSON and exits 0', () => {
    const { bus, text } = busWithAdmittedCard()
    const db = openBus(bus)
    const admission = (db.prepare(`SELECT id FROM events WHERE type = '${CARD_ADMITTED}'`).get() as { id: number }).id
    db.close()
    const ran = run(bus, ['#90', '--chain'])
    expect(ran.code).toBe(0)
    expect(ran.err).toEqual([])
    expect(ran.out).not.toBe(text)
    expect(JSON.parse(ran.out)).toEqual({ card: 90, versions: [admission], decisions: [...new Set(text.match(/\bD-[1-9]\d*\b/g) ?? [])], verdict: null, proof: null })
  })

  it('card --chain of a card with no admitted text exits 1 with a [card] line', () => {
    const { bus } = busWithAdmittedCard()
    const ran = run(bus, ['91', '--chain'])
    expect(ran.code).toBe(1)
    expect(ran.out).toBe('')
    expect(ran.err).toEqual([expect.stringMatching(/^\[card\] card #91 has no admitted text/)])
  })

  it.each(CONTRACTS)('card --contract %s prints the fields its contract names', (contract) => {
    const { bus } = busWithAdmittedCard()
    expect(Object.keys(JSON.parse(run(bus, ['90', '--contract', contract]).out) as object)).toEqual([...CONTRACT_FIELDS[contract]])
  })

  it('the review contract carries the prose before the witnesses and the witnesses apart', () => {
    const { bus } = busWithAdmittedCard()
    expect(JSON.parse(run(bus, ['90', '--contract', 'review']).out)).toMatchObject({
      prose: 'Do the thing.\n\nPath (D-76): cheap, set by the owner.',
      witnesses: ['`pnpm exec vitest run scripts/tests/a.test.ts` exits 0'],
      unclear: [],
    })
  })

  it('the board contract carries the card state of the bus', () => {
    const { bus } = busWithAdmittedCard()
    expect(JSON.parse(run(bus, ['90', '--contract', 'board']).out)).toMatchObject({ state: 'queued', priority: null, depends: [], creates: [] })
  })

  it('a card with no admitted text exits 1 with a [card] line', () => {
    const { bus } = busWithAdmittedCard()
    const ran = run(bus, ['91', '--md'])
    expect(ran.code).toBe(1)
    expect(ran.out).toBe('')
    expect(ran.err).toEqual([expect.stringMatching(/^\[card\] card #91 has no admitted text/)])
  })

  it('a bus that does not exist reads as a card with no admitted text', () => {
    expect(run(path.join(tmpdir(), 'no-such-bus.db'), ['90', '--md']).code).toBe(1)
  })

  it('the intake contract carries every card field and the admitted text', () => {
    const { bus, text } = busWithAdmittedCard()
    expect(JSON.parse(run(bus, ['90', '--contract', 'intake']).out)).toMatchObject({
      id: 90,
      name: 'contract-card',
      kind: 'implement',
      milestone: 'netwatch',
      size: 'S',
      contour: 'cheap',
      decision: 'auto',
      cardLine: CARD,
      continue: 'stop',
      path: 'cheap, set by the owner.',
      lane: WINDOW_LANE,
      text,
    })
  })

  it('the close contract carries the id, the card line and the admitted text', () => {
    const { bus, text } = busWithAdmittedCard()
    expect(JSON.parse(run(bus, ['90', '--contract', 'close']).out)).toEqual({ id: 90, cardLine: CARD, text })
  })

  it('a stored text the card grammar refuses exits 1 with the grammar reason, and --md still prints it', () => {
    const { bus } = busWithAdmittedCard()
    const refused = 'not a card\n'
    const db = openBus(bus)
    try {
      db.prepare(`INSERT INTO events (ts, type, actor, card_id, dedupe_key, payload, legacy) VALUES ('2026-10-13T10:00:00.000Z', '${CARD_ADMITTED}', 'test', 90, 'refused', ?, 0)`).run(JSON.stringify({ card: CARD, text: refused, textSha: createHash('sha256').update(refused).digest('hex') }))
      reduce(db)
    }
    finally {
      db.close()
    }
    const ran = run(bus, ['90', '--contract', 'start'])
    expect(ran.code).toBe(1)
    expect(ran.out).toBe('')
    expect(ran.err).toEqual([expect.stringMatching(/^\[card\] card #90: the admitted text is refused by the card grammar: /)])
    expect(run(bus, ['90', '--md'])).toEqual({ code: 0, out: refused, err: [] })
  })

  it('an unknown contract is named in the refusal before the usage', () => {
    expect(run(path.join(tmpdir(), 'no-such-bus.db'), ['90', '--contract', 'atlas']).err).toEqual([expect.stringMatching(/^\[card\] no contract atlas; usage: pnpm card <N>/)])
  })

  it.each([[[]], [['90']], [['90', '--contract']], [['90', '--contract', 'atlas']], [['x', '--md']], [['90', '--md', 'extra']], [['90', '--chain', 'extra']], [['x', '--chain']]])('%j is refused with the usage and exit 2', (args) => {
    const ran = run(path.join(tmpdir(), 'no-such-bus.db'), args)
    expect(ran.code).toBe(2)
    expect(ran.err).toEqual([expect.stringMatching(/^\[card\] .*usage: pnpm card <N>/)])
  })
})
