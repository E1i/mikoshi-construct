import type { Site } from '../../contract/factory/overlaps.js'
import type { DecisionRow } from '../../policy/decisions/decisions.js'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ownerAllowed } from '../../../src/commands/intake/admit.js'
import { CONCEPTS } from '../../contract/factory/concepts.js'
import { findSites } from '../../contract/factory/overlaps.js'
import { openBus } from '../../core/db.js'
import { reduce } from '../../core/reducer.js'
import { parseDecisions, projectDecisions } from '../../policy/decisions/decisions.js'
import { decisionsIntake } from '../../policy/decisions/import.js'
import { BusDecisions, recordDecision } from '../../policy/decisions/index.js'
import { busProjections } from '../../supervisor/composition.js'

const REPO_ROOT = path.join(import.meta.dirname, '..', '..', '..')
const CONCEPT = CONCEPTS.find(concept => concept.id === 'owner-decisions')!

interface Carrier {
  path: string
  reason: string
}

const CARRIERS: readonly Carrier[] = [
  { path: 'scripts/core/bus-path.ts', reason: 'names the file of the projection beside the bus; the folder imports the name from here' },
  { path: 'scripts/core/inbox.ts', reason: 'the inbox closes a wait a later decision answers; moves to decisionAnswersTheStop in a later slice of P2' },
  { path: 'scripts/core/reducer.ts', reason: 'the reducer reads the decisions a fold just recorded; moves to the port in a later slice of P2' },
  { path: 'scripts/nodes/answer/answer-source.ts', reason: 'the answer node asks whether a decision was recorded after a stop; moves to the port in a later slice of P2' },
  { path: 'scripts/nodes/launch/launch-candidates.ts', reason: 'launch reads the decisions in force for its prompt; moves to the port in a later slice of P2' },
]

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function tempRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'decisions-seal-'))
  roots.push(root)
  return root
}

function sealOf(sites: readonly Site[], carriers: readonly Carrier[]): { outside: string[], stale: string[] } {
  const files = [...new Set(sites.map(site => site.file))]
  return {
    outside: files.filter(file => !carriers.some(carrier => carrier.path === file)),
    stale: carriers.filter(carrier => !files.includes(carrier.path)).map(carrier => carrier.path),
  }
}

function planted(files: Record<string, string>): string {
  const root = tempRoot()
  for (const tree of ['scripts', 'src'])
    mkdirSync(path.join(root, tree), { recursive: true })
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    writeFileSync(path.join(root, file), text)
  }
  return root
}

const A_READ = 'const decisions = parseDecisions(readFileSync(decisionsFileOf(bus), \'utf8\'))\n'
const ALLOWANCE = 'разрешить понижение свидетеля #80 W1'
const WITNESS = 'the board renders the decisions'
const AT = new Date('2026-11-11T09:00:00.000Z')

describe('the decisions seal', () => {
  it('a read of the decisions outside policy/decisions is red', () => {
    expect(CONCEPT.owner).toBe('scripts/policy/decisions/')
    const root = planted({ 'scripts/nodes/planted.ts': A_READ, 'src/commands/planted.ts': 'db.prepare(\'SELECT text FROM decisions\')\n', 'scripts/policy/decisions/held.ts': A_READ })
    expect(sealOf(findSites(root, [CONCEPT]), []).outside).toEqual(['scripts/nodes/planted.ts', 'src/commands/planted.ts'])
    const real = sealOf(findSites(REPO_ROOT, [CONCEPT]), CARRIERS)
    expect(real.outside).toEqual([])
    expect(real.stale).toEqual([])
    expect(CARRIERS.filter(carrier => carrier.reason.trim() === '')).toEqual([])
  })

  it('a hand-added line in the markdown grants no witness downgrade', () => {
    const root = tempRoot()
    const bus = path.join(root, 'bus.db')
    const file = path.join(root, 'owner-decisions.md')
    writeFileSync(file, `# Owner decisions\n\n- D-7 · 2026-11-11 — [owner] ${ALLOWANCE} · card #80 · decisions:add\n`)
    const db = openBus(bus)
    try {
      decisionsIntake(db, file, () => AT)()
      reduce(db, 'pending', busProjections())
      const decisions = new BusDecisions(db)
      expect(decisions.inForce()).toMatchObject([{ decisionId: 7, words: ALLOWANCE, cards: [80], written: false }])
      expect(ownerAllowed(decisions, 80, [WITNESS], [WITNESS])).toBe(false)
      recordDecision(db, { ts: AT.toISOString(), decisionId: 8, text: `[owner] ${ALLOWANCE}`, cards: [80] })
      reduce(db, 'pending', busProjections())
      expect(ownerAllowed(decisions, 80, [WITNESS], [WITNESS])).toBe(true)
    }
    finally {
      db.close()
    }
  })

  it('a rebuild does not duplicate a line between the file and the archive', () => {
    const line = '- D-342 · 2026-11-01 — [owner] keep the duplicate out · decisions:add'
    const row: DecisionRow = { number: 342, text: '[owner] keep the duplicate out', cards: [], until: null, inForce: true, written: true, recordedAt: '2026-11-01T00:00:00.000Z', supersededBy: null }
    const archiveHeader = '# Owner decisions — archive\n\n'
    const spent = Array.from({ length: 341 }, (_, index) => `- D-${index + 1} · 2026-10-01 — [owner] spent word ${index + 1} · decisions:add\n`).join('')
    const projected = projectDecisions([row], `# Owner decisions\n\n${line}\n`, `${archiveHeader}${spent}${line}\n`, archiveHeader)
    const held = [projected.file, projected.archive].flatMap(text => parseDecisions(text).decisions).filter(decision => decision.number === 342)
    expect(held).toHaveLength(1)
    expect(parseDecisions(projected.file).decisions.map(decision => decision.number)).toEqual([342])
    const older = '- D-342 · 2026-09-01 — [owner] an older word under a reused number · decisions:add'
    const reused = projectDecisions([row], `# Owner decisions\n\n${line}\n`, `${archiveHeader}${spent}${older}\n${line}\n`, archiveHeader)
    expect(reused.archive.split('\n')).toContain(older)
  })
})
