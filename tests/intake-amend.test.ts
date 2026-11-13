import type { DecisionsPort } from '../scripts/policy/decisions/decisions.js'
import type { AdmitResult } from '../src/commands/intake/admit.js'
import type { AmendFlags } from '../src/commands/intake/amend.js'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BUS_DB_VARIABLE, openBus } from '../scripts/core/db.js'
import { CARD_ADMITTED, CARD_MOVED } from '../scripts/core/events.js'
import { reduce } from '../scripts/core/reducer.js'
import { busCardAdmissions, busCardEvents, runBusIntake } from '../scripts/intake/intake.js'
import { InMemoryDecisions } from '../scripts/policy/decisions/decisions.js'
import { busProjections } from '../scripts/supervisor/composition.js'
import { runAdmit } from '../src/commands/intake/admit.js'
import { amendedText, runAmend } from '../src/commands/intake/amend.js'
import { INTAKE_EXIT } from '../src/commands/intake/index.js'

const NOW = new Date('2026-10-13T09:00:00.000Z')
const CARD = '#80 amend-card [implement/runner/S/cheap/owner] · depends — · blocks —'
const ACCEPTANCE = '`pnpm exec vitest run tests/a.test.ts` exits 0; red on main'
const INVARIANT = '`pnpm exec vitest run tests/a.test.ts` exits 0'
const LANE = 'lane-3'
const roots: string[] = []

afterEach(() => {
  vi.unstubAllEnvs()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

interface World { root: string, parking: string, repo: string, bus: string, decisions: DecisionsPort }

function world(): World {
  const root = mkdtempSync(path.join(tmpdir(), 'intake-amend-'))
  roots.push(root)
  const repo = path.join(root, 'repo')
  mkdirSync(path.join(repo, 'src', 'board'), { recursive: true })
  writeFileSync(path.join(repo, 'src', 'board', 'run.ts'), '')
  writeFileSync(path.join(repo, 'src', 'board', 'tail.ts'), '')
  const parking = path.join(root, 'parking')
  mkdirSync(parking, { recursive: true })
  return { root, parking, repo, bus: path.join(root, 'bus.db'), decisions: new InMemoryDecisions([]) }
}

function cardText(witness: string, touches = 'src/board/run.ts'): string {
  return `card: ${CARD}\nbranch: feat/card-80\ntouches: ${touches}\ncontinue: stop\nwho: shift\n\nDo the thing.\n\nWitnesses:\n- ${witness}\n`
}

function withBus<T>(w: World, run: (ports: { events: ReturnType<typeof busCardEvents>, admissions: ReturnType<typeof busCardAdmissions> }) => T): T {
  const db = openBus(w.bus)
  try {
    const result = run({ events: busCardEvents(db), admissions: busCardAdmissions(db) })
    reduce(db, 'pending', busProjections())
    return result
  }
  finally {
    db.close()
  }
}

function admitFromFile(w: World, text: string): AdmitResult {
  const file = path.join(w.parking, '80.md')
  writeFileSync(file, text)
  const result = withBus(w, ({ events, admissions }) => runAdmit({ file, dir: w.repo, dryRun: false, autoConfirm: true, parkingRoot: w.parking, decisions: w.decisions, events, admissions, cardStates: () => new Map() }, () => NOW))
  rmSync(file)
  return result
}

function amend(w: World, flags: AmendFlags, dryRun = false): AdmitResult {
  return withBus(w, ({ events, admissions }) => runAmend({ card: '#80', flags, dir: w.repo, dryRun, autoConfirm: true, parkingRoot: w.parking, decisions: w.decisions, events, admissions, cardStates: () => new Map() }, () => NOW))
}

function admissions(w: World): { text: string, source: string | null }[] {
  const db = openBus(w.bus)
  try {
    return db.prepare(`SELECT json_extract(payload, '$.text') AS text, json_extract(payload, '$.source') AS source FROM events WHERE type = ? AND card_id = 80 ORDER BY id`).all(CARD_ADMITTED) as { text: string, source: string | null }[]
  }
  finally {
    db.close()
  }
}

function latestLane(w: World): string | null {
  const db = openBus(w.bus)
  try {
    return (db.prepare(`SELECT json_extract(payload, '$.lane') AS lane FROM events WHERE type = ? AND card_id = 80 ORDER BY id DESC LIMIT 1`).get(CARD_ADMITTED) as { lane: string | null }).lane
  }
  finally {
    db.close()
  }
}

function ownerWaits(w: World): number {
  const db = openBus(w.bus)
  try {
    return Number((db.prepare('SELECT count(*) AS n FROM owner_waits').get() as { n: number }).n)
  }
  finally {
    db.close()
  }
}

describe('construct intake --amend edits an admitted card straight in the bus', () => {
  it('--amend #80 --touches +path writes one card.admitted whose body carries the path, with no file on disk', () => {
    const w = world()
    expect(admitFromFile(w, cardText(ACCEPTANCE))).toMatchObject({ status: 'admitted' })
    expect(amend(w, { touches: '+src/board/tail.ts' })).toMatchObject({ status: 'admitted', source: 'amend', file: '#80' })
    const recorded = admissions(w)
    expect(recorded).toHaveLength(2)
    expect(recorded.at(-1)).toMatchObject({ source: 'amend', text: expect.stringContaining('touches: src/board/run.ts, src/board/tail.ts\n') })
    expect(readdirSync(w.parking)).toEqual([])
  })

  it('--touches -path removes a touch, and removing one the card does not name is refused', () => {
    const w = world()
    admitFromFile(w, cardText(ACCEPTANCE, 'src/board/run.ts, src/board/tail.ts'))
    expect(amend(w, { touches: '-src/board/gone.ts' })).toMatchObject({ status: 'refused', why: expect.stringContaining('src/board/gone.ts') })
    expect(amend(w, { touches: '-src/board/tail.ts' })).toMatchObject({ status: 'admitted' })
    expect(admissions(w).at(-1)?.text).toContain('touches: src/board/run.ts\n')
  })

  it('--witness old=new runs the same downgrade check as --admit: a weaker witness without an allowance is an owner wait', () => {
    const w = world()
    admitFromFile(w, cardText(ACCEPTANCE))
    const held = amend(w, { witness: `${ACCEPTANCE}=${INVARIANT}` })
    expect(held).toMatchObject({ status: 'ownerWait', downgrades: [ACCEPTANCE], inBus: true })
    expect(admissions(w)).toHaveLength(1)
    expect(ownerWaits(w)).toBe(1)
    expect(admitFromFile(w, cardText(INVARIANT))).toMatchObject({ status: 'ownerWait', downgrades: [ACCEPTANCE] })
  })

  it('--witness naming no witness of the card is refused and writes nothing', () => {
    const w = world()
    admitFromFile(w, cardText(ACCEPTANCE))
    expect(amend(w, { witness: `\`pnpm lint\` exits 0=${INVARIANT}` }).status).toBe('refused')
    expect(admissions(w)).toHaveLength(1)
  })

  it('a dry run of --amend writes no event and prints the amended body', () => {
    const w = world()
    admitFromFile(w, cardText(ACCEPTANCE))
    const result = amend(w, { note: 'owner: keep it small', who: 'window' }, true)
    expect(result).toMatchObject({ status: 'dryRun', card: { text: expect.stringContaining('owner: keep it small') } })
    expect(result.status === 'dryRun' ? result.card.text : '').toContain('who: window\n')
    expect(admissions(w)).toHaveLength(1)
  })

  it('a dry run of a downgrading --witness opens no owner wait', () => {
    const w = world()
    admitFromFile(w, cardText(ACCEPTANCE))
    expect(amend(w, { witness: `${ACCEPTANCE}=${INVARIANT}` }, true)).toMatchObject({ status: 'ownerWait', dryRun: true })
    expect(ownerWaits(w)).toBe(0)
  })

  it('refuses a card the bus never admitted, an unknown who, and an amend with no edit', () => {
    const w = world()
    expect(amend(w, { note: 'x' })).toMatchObject({ status: 'refused', why: expect.stringContaining('#80') })
    admitFromFile(w, cardText(ACCEPTANCE))
    expect(amend(w, { who: 'nobody' }).status).toBe('refused')
    expect(amend(w, {}).status).toBe('refused')
    expect(admissions(w)).toHaveLength(1)
  })

  it('--creates adds a creates line after touches and removing its last entry drops the line', () => {
    const added = amendedText(cardText(ACCEPTANCE), { creates: '+src/board/new.ts' })
    expect(added).toMatchObject({ kind: 'edited', text: expect.stringContaining('touches: src/board/run.ts\ncreates: src/board/new.ts\n') })
    const removed = amendedText(added.kind === 'edited' ? added.text : '', { creates: '-src/board/new.ts' })
    expect(removed).toEqual({ kind: 'edited', text: cardText(ACCEPTANCE) })
  })

  it('an amend of a card in lane-N leaves it in lane-N', () => {
    const w = world()
    admitFromFile(w, cardText(ACCEPTANCE))
    withBus(w, ({ events }) => events({ type: CARD_MOVED, cardId: 80, ts: NOW.toISOString(), dedupeKey: `${CARD_MOVED}:80:${LANE}`, payload: { lane: LANE, to: path.join(w.parking, LANE) } }))
    expect(latestLane(w)).toBe(LANE)

    expect(amend(w, { touches: '+src/board/tail.ts' }).status).toBe('admitted')
    expect(latestLane(w)).toBe(LANE)

    const draft = path.join(w.root, 'drafts', '80.md')
    mkdirSync(path.dirname(draft), { recursive: true })
    writeFileSync(draft, `${cardText(ACCEPTANCE, 'src/board/run.ts, src/board/tail.ts')}\nA draft outside the parking.\n`)
    const admitted = withBus(w, ({ events, admissions }) => runAdmit({ file: draft, dir: w.repo, dryRun: false, autoConfirm: true, parkingRoot: w.parking, decisions: w.decisions, events, admissions, cardStates: () => new Map() }, () => NOW))
    expect(admitted.status).toBe('admitted')
    expect(latestLane(w)).toBe(LANE)
  })

  it('the bus entry takes --amend with its flags and writes card.admitted with source amend', async () => {
    const w = world()
    admitFromFile(w, cardText(ACCEPTANCE))
    vi.stubEnv(BUS_DB_VARIABLE, w.bus)
    vi.stubEnv('HOME', w.root)
    mkdirSync(path.join(w.root, '.construct', 'parking'), { recursive: true })
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const previousExit = process.exitCode
    const db = openBus(w.bus)
    try {
      await runBusIntake(db, ['--plain', '--amend', '#80', '--touches', '+src/board/tail.ts', '--auto-confirm', '--dir', w.repo])
      expect(process.exitCode ?? 0).not.toBe(INTAKE_EXIT.refused)
    }
    finally {
      db.close()
      write.mockRestore()
      process.exitCode = previousExit
    }
    expect(admissions(w).at(-1)).toMatchObject({ source: 'amend', text: expect.stringContaining('src/board/tail.ts') })
    expect(existsSync(path.join(w.root, '.construct', 'parking', '80.md'))).toBe(false)
  })
})

describe('the intake skill on amending', () => {
  const readRepoFile = (relative: string): string => readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8')

  function amendParagraph(): string {
    const skill = readRepoFile('.claude/skills/intake/SKILL.md')
    return skill.split('\n\n').find(block => block.startsWith('To amend an admitted card')) ?? ''
  }

  it('the intake skill names both amend entries and keeps export for what they do not cover', () => {
    const paragraph = amendParagraph()
    expect(paragraph).toContain('construct-intake --amend <#N>')
    expect(paragraph).toContain('pnpm bus:request amend --card <N>')
    expect(paragraph).toContain('For an edit they do not cover')
    expect(paragraph).toContain('pnpm intake --export \'#N\'')
    expect(paragraph).toContain('pnpm intake --admit <draft>')
  })

  it.each(['Amending an admitted card', 'Amending by request'])('the skill points at the docs/cli.md section %s, which exists', (section) => {
    expect(amendParagraph()).toContain(`"${section}"`)
    expect(readRepoFile('docs/cli.md')).toContain(`**${section}.**`)
  })

  it('the skill leaves the flags of the two entries to docs/cli.md', () => {
    const paragraph = amendParagraph()
    for (const flag of ['--touches', '--witness', '--add-witness', '--owner-words', '--depends'])
      expect(paragraph).not.toContain(flag)
  })
})
