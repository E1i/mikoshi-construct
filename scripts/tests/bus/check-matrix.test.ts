import type { Matrix, MatrixMutation, MatrixResult } from '../../bus/check-matrix.js'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { appendMatrix, CHECKS_MATRIX_EVENT, matrixArguments, matrixSummary } from '../../bus/check-matrix.js'
import { openBus } from '../../bus/db.js'

const HEAD = 'a'.repeat(40)
const TS = '2026-10-20T10:00:00.000Z'

function mutation(id: string): MatrixMutation {
  return { card: 7, id, file: 'scripts/bus/merge-worker.ts', layer: 'bus:merge', operator: '', find: 'ok = true', replacement: 'ok = false', killedBy: 'scripts/tests/bus/merge-worker.test.ts' }
}

function scratchBus() {
  return openBus(path.join(mkdtempSync(path.join(os.tmpdir(), 'check-matrix-bus-')), 'bus.db'))
}

interface EventRow { type: string, actor: string, card_id: number | null, pr: number, head: string | null, payload: string }

function events(db: ReturnType<typeof openBus>): EventRow[] {
  return db.prepare('SELECT type, actor, card_id, pr, head, payload FROM events ORDER BY id').all() as unknown as EventRow[]
}

describe('checks:matrix and the bus', () => {
  it('checks:matrix appends its matrix for a PR to the bus', () => {
    const [m1, m2, m3] = [mutation('m1'), mutation('m2'), mutation('m3')]
    const matrix: Matrix = { full: null, layers: [{ layer: 'bus:merge', tests: ['scripts/tests/bus/merge-worker.test.ts'], mutations: [m1, m2, m3] }], skipped: [{ mutation: mutation('m4'), why: 'no test predicted to kill it' }] }
    const results: MatrixResult[] = [
      { mutation: m1, outcome: 'killed', why: null },
      { mutation: m2, outcome: 'survived', why: null },
      { mutation: m3, outcome: 'not-run', why: 'its test did not run' },
    ]
    const db = scratchBus()
    expect(appendMatrix(db, { pr: 922, head: HEAD }, matrix, results, TS, 'test')).toBe(true)
    const [row] = events(db)
    expect(row).toMatchObject({ type: CHECKS_MATRIX_EVENT, actor: 'worker:checks-matrix:test', card_id: null, pr: 922, head: HEAD })
    expect(JSON.parse(row!.payload)).toEqual({ full: null, killed: 1, survived: 1, notRun: 1, skipped: 1, summary: matrixSummary(matrix, results) })
    db.close()
  })

  it('a second matrix for the same PR head is not appended twice, and one for a full run carries its reason', () => {
    const full: Matrix = { full: 'the change touches the harness', layers: [], skipped: [] }
    const db = scratchBus()
    expect(appendMatrix(db, { pr: 9, head: HEAD }, full, [], TS, 'test')).toBe(true)
    expect(appendMatrix(db, { pr: 9, head: HEAD }, full, [], '2026-10-20T11:00:00.000Z', 'test')).toBe(false)
    expect(appendMatrix(db, { pr: 9, head: null }, full, [], TS, 'test')).toBe(true)
    expect(events(db).map(row => JSON.parse(row.payload).full)).toEqual(['the change touches the harness', 'the change touches the harness'])
    db.close()
  })

  it('reads the PR and head from its flags and the changed files from the rest, and refuses a malformed flag', () => {
    expect(matrixArguments(['a.ts', 'b.ts'])).toEqual({ changed: ['a.ts', 'b.ts'], target: null })
    expect(matrixArguments(['--pr', '922', '--head', HEAD, 'a.ts'])).toEqual({ changed: ['a.ts'], target: { pr: 922, head: HEAD } })
    expect(matrixArguments(['--pr', '922', 'a.ts'])).toEqual({ changed: ['a.ts'], target: { pr: 922, head: null } })
    expect(() => matrixArguments(['--pr', 'x'])).toThrow('--pr is not a positive integer: x')
    expect(() => matrixArguments(['--pr', '1', '--head', 'abc'])).toThrow('--head is not a full sha: abc')
    expect(() => matrixArguments(['--head', HEAD])).toThrow('--head needs --pr')
  })
})
