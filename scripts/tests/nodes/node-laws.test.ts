import type { LawCell, LawCells, LawId, LawNode } from '../../nodes/laws.js'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { NODE_DECLARATIONS } from '../../contract/factory/nodes.js'
import { LAW_GAP_PREFIX, lawGapNumbers, ratchetBreaks, readRatchet } from '../../contract/ratchet.js'
import { gapRows, LAW_CELLS, LAW_NODES, lawIds, LAWS } from '../../nodes/laws.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')
const NODES_TREE = path.join(REPO_ROOT, 'scripts', 'nodes')
const OWNER_LAWS = ['Z1', 'Z2', 'Z3', 'Z4', 'Z5', 'Z6', 'Z7']

interface Witness {
  law: LawId
  run: (node: LawNode) => Promise<void>
}

type Witnesses = Readonly<Record<string, Witness>>

const WITNESSES: Witnesses = {}

function cellKinds(cell: LawCell): string[] {
  return ['witness', 'notApplicable', 'gap'].filter(kind => kind in cell)
}

function cellFaults(law: LawId, node: LawNode, cell: LawCell | undefined, witnesses: Witnesses): string[] {
  if (cell === undefined)
    return [`${law} × ${node}: no cell`]
  if (cellKinds(cell).length !== 1)
    return [`${law} × ${node}: a cell is exactly one of witness, notApplicable or gap`]
  if ('witness' in cell)
    return witnesses[cell.witness]?.law === law ? [] : [`${law} × ${node}: witness ${cell.witness} is not a witness of ${law} the suite runs`]
  if ('notApplicable' in cell)
    return cell.notApplicable.trim() === '' ? [`${law} × ${node}: not applicable without its reason`] : []
  return cell.gap.length === 0 || cell.gap.some(card => !Number.isInteger(card) || card <= 0) ? [`${law} × ${node}: a gap names the card that closes it`] : []
}

function registryFaults(cells: LawCells, witnesses: Witnesses): string[] {
  const unknownLaws = Object.keys(cells).filter(law => !Object.hasOwn(LAWS, law)).map(law => `${law}: a law the registry does not declare`)
  return [...unknownLaws, ...lawIds().flatMap((law) => {
    const row = cells[law] as Partial<Record<LawNode, LawCell>> | undefined
    if (row === undefined)
      return [`${law}: no row`]
    const strangers = Object.keys(row).filter(node => !(LAW_NODES as readonly string[]).includes(node)).map(node => `${law} × ${node}: not a node`)
    return [...strangers, ...LAW_NODES.flatMap(node => cellFaults(law, node, row[node], witnesses))]
  })]
}

function failureOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function lawOutcome(law: LawId, node: LawNode, witnesses: Witnesses): Promise<string | null> {
  const ofTheLaw = Object.entries(witnesses).filter(([, witness]) => witness.law === law)
  if (ofTheLaw.length === 0)
    return `no witness of ${law} runs on ${node}`
  const failures: string[] = []
  for (const [id, witness] of ofTheLaw) {
    try {
      await witness.run(node)
      return null
    }
    catch (error) {
      failures.push(`${id}: ${failureOf(error)}`)
    }
  }
  return failures.join('; ')
}

function gapTitle(law: LawId, node: LawNode, cards: readonly number[]): string {
  return `gap: ${law} × ${node} → ${cards.map(card => `#${card}`).join(', ')}`
}

function workerOf(node: string): string {
  return path.join(NODES_TREE, node, `${node}-worker.ts`)
}

function recordedLawGaps(): Record<string, number> {
  return Object.fromEntries(Object.entries(readRatchet(REPO_ROOT)).filter(([key]) => key.startsWith(LAW_GAP_PREFIX)))
}

describe('the laws of a node', () => {
  it('every law has a cell for each of the 8 nodes and every witness cell names a witness', () => {
    expect(lawIds()).toEqual(OWNER_LAWS)
    expect(LAW_NODES.filter(node => !existsSync(workerOf(node)))).toEqual([])
    expect(NODE_DECLARATIONS.map(({ kind }) => kind).filter(kind => !(LAW_NODES as readonly string[]).includes(kind))).toEqual([])
    expect(LAW_NODES).toHaveLength(8)
    expect(registryFaults(LAW_CELLS, WITNESSES)).toEqual([])

    const unwitnessed = { ...LAW_CELLS, Z2: { ...LAW_CELLS.Z2, merge: { witness: 'Z2-unwritten' } } }
    const missing = { ...LAW_CELLS, Z5: Object.fromEntries(Object.entries(LAW_CELLS.Z5).filter(([node]) => node !== 'review')) } as unknown as LawCells
    const unreasoned = { ...LAW_CELLS, Z1: { ...LAW_CELLS.Z1, close: { notApplicable: ' ' } } }
    const cardless = { ...LAW_CELLS, Z6: { ...LAW_CELLS.Z6, update: { gap: [] } } }

    expect(registryFaults(unwitnessed, WITNESSES)).toEqual([expect.stringContaining('Z2 × merge: witness Z2-unwritten')])
    expect(registryFaults(missing, WITNESSES)).toEqual(['Z5 × review: no cell'])
    expect(registryFaults(unreasoned, WITNESSES)).toEqual(['Z1 × close: not applicable without its reason'])
    expect(registryFaults(cardless, WITNESSES)).toEqual(['Z6 × update: a gap names the card that closes it'])
  })

  it('a gap cell that passes is red until its row is struck', async () => {
    const passing: Witnesses = { 'Z5-seeded': { law: 'Z5', run: async () => {} } }
    const failing: Witnesses = { 'Z5-seeded': { law: 'Z5', run: async () => Promise.reject(new Error('launch wrote no event')) } }

    expect(await lawOutcome('Z5', 'launch', passing)).toBeNull()
    expect(await lawOutcome('Z5', 'launch', failing)).toBe('Z5-seeded: launch wrote no event')
    expect(await lawOutcome('Z5', 'launch', {})).toBe('no witness of Z5 runs on launch')
    expect(registryFaults({ ...LAW_CELLS, Z5: { ...LAW_CELLS.Z5, launch: { witness: 'Z5-seeded' } } }, passing)).toEqual([])
  })

  it('a new gap row is a ratchet break', () => {
    const recorded = recordedLawGaps()
    const added = { ...LAW_CELLS, Z1: { ...LAW_CELLS.Z1, close: { gap: [1777] } } }
    const struck = { ...LAW_CELLS, Z2: { ...LAW_CELLS.Z2, answer: { witness: 'Z2-answer' } } }

    expect(recorded).toEqual(lawGapNumbers())
    expect(Object.keys(recorded)).toHaveLength(gapRows().length)
    expect(ratchetBreaks(recorded, lawGapNumbers())).toEqual([])
    expect(ratchetBreaks(recorded, lawGapNumbers(added))).toEqual([expect.stringContaining(`${LAW_GAP_PREFIX}Z1:close grew from 0 to 1`)])
    expect(ratchetBreaks(recorded, lawGapNumbers(struck))).toEqual([expect.stringContaining(`${LAW_GAP_PREFIX}Z2:answer went down from 1 to 0`)])
  })

  describe('each law over each node', () => {
    for (const law of lawIds()) {
      for (const node of LAW_NODES) {
        const cell = LAW_CELLS[law][node]
        if ('witness' in cell) {
          it(`${law} × ${node}`, async () => {
            const witness = WITNESSES[cell.witness]

            expect(witness?.law, `${cell.witness} is not a witness of ${law}`).toBe(law)
            await witness!.run(node)
          })
        }
        if ('gap' in cell) {
          it(gapTitle(law, node, cell.gap), async () => {
            expect(await lawOutcome(law, node, WITNESSES), `${law} × ${node} passes: strike its gap row in scripts/nodes/laws.ts and lower contract/ratchet.json in this pull request`).not.toBeNull()
          })
        }
      }
    }
  })
})
