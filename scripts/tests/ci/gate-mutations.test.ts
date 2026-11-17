import type { Matrix, MatrixMutation, RunTest } from '../../cli/check-matrix.js'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MUTATION_CEILING_MS, mutationGate, SURVIVED_HEADER, UNCHECKED, witnessMutations } from '../../ci/gate-mutations.js'
import { mutationStep } from '../../ci/prepush.js'

const FILE = 'scripts/ci/a.ts'
const OTHER_FILE = 'scripts/ci/b.ts'
const WITNESS = 'scripts/tests/ci/a.test.ts'
const NOT_A_WITNESS = 'scripts/tests/ci/other.test.ts'
const SOURCE = 'export function ok(): boolean {\n  const ok = true\n  return ok\n}\n'
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function tree(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'gate-mutations-'))
  roots.push(root)
  for (const [file, text] of [[FILE, SOURCE], [OTHER_FILE, SOURCE], [WITNESS, ''], [NOT_A_WITNESS, '']] as const) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    writeFileSync(path.join(root, file), text)
  }
  return root
}

function mutation(id: string, file: string, killedBy: string): MatrixMutation {
  return { card: 1956, id, file, layer: 'ci', operator: 'const ok = true → const ok = false', find: 'const ok = true', replacement: 'const ok = false', killedBy }
}

const WITNESS_MUTATION = mutation('M1', FILE, WITNESS)
const MATRIX: Matrix = {
  full: null,
  layers: [{ layer: 'ci', tests: [WITNESS, NOT_A_WITNESS], mutations: [WITNESS_MUTATION, mutation('M2', FILE, NOT_A_WITNESS), mutation('M3', OTHER_FILE, WITNESS)] }],
  skipped: [],
}

function survivingRuns(seen: string[]): RunTest {
  return (root, test) => {
    seen.push(`${test}:${readFileSync(path.join(root, FILE), 'utf8').includes('const ok = false') ? 'mutated' : 'clean'}`)
    return 'passed'
  }
}

const hanging: RunTest = (_root, _test, signal) => new Promise(resolve => signal.addEventListener('abort', () => resolve('interrupted')))

describe('the pre-push gate runs the predicted mutations of the card witnesses on the touched files', () => {
  it('a session with a surviving witness mutation fails the gate and does not push', async () => {
    const root = tree()
    const seen: string[] = []
    const lines: string[] = []

    const code = await mutationStep([FILE], new Map(), { kind: 'card', card: 1956, touches: [FILE], reading: { layers: [], paths: [], tests: [] }, witnesses: [WITNESS] }, {
      log: line => lines.push(line),
      mutations: (changed, _graph, witnesses) => mutationGate({ matrix: () => MATRIX, witnesses, changed, root, runTest: survivingRuns(seen) }),
    })

    expect(code).toBe(1)
    expect(seen).toEqual([`${WITNESS}:clean`, `${WITNESS}:mutated`])
    expect(lines).toEqual([[SURVIVED_HEADER, `survived: ${FILE}:2 ${WITNESS_MUTATION.operator}`].join('\n')])
    expect(readFileSync(path.join(root, FILE), 'utf8')).toBe(SOURCE)
  })

  it('a killed witness mutation leaves the gate green and says nothing', async () => {
    const root = tree()
    const killing: RunTest = (at, test) => readFileSync(path.join(at, FILE), 'utf8').includes('const ok = false') && test === WITNESS ? 'failed' : 'passed'

    expect(await mutationGate({ matrix: () => MATRIX, witnesses: [WITNESS], changed: [FILE], root, runTest: killing })).toEqual({ lines: [], code: 0 })
  })

  it('past the time ceiling the gate prints mutations unchecked and pushes', async () => {
    const root = tree()

    const gate = await mutationGate({ matrix: () => MATRIX, witnesses: [WITNESS], changed: [FILE], root, runTest: hanging, ceilingMs: 20 })

    expect(gate.code).toBe(0)
    expect(gate.lines).toEqual([`${UNCHECKED}: the 1 predicted witness mutations did not fit under 0 s; review checks them`])
    expect(readFileSync(path.join(root, FILE), 'utf8')).toBe(SOURCE)
    expect(MUTATION_CEILING_MS).toBe(120_000)
  })

  it('an unreadable catalog or a full run leaves the mutations unchecked and the push goes', async () => {
    const root = tree()
    const noBus = (): Matrix => {
      throw new Error('no bus')
    }
    const unreadable = await mutationGate({ matrix: noBus, witnesses: [WITNESS], changed: [FILE], root })
    const full = await mutationGate({ matrix: () => ({ full: 'a root config changed', layers: [], skipped: [] }), witnesses: [WITNESS], changed: [FILE], root })

    expect(unreadable).toEqual({ lines: [`${UNCHECKED}: the check catalog could not be read: no bus`], code: 0 })
    expect(full).toEqual({ lines: [`${UNCHECKED}: the change reaches a full run (a root config changed), which has no layered mutations`], code: 0 })
  })

  it('only mutations a witness is predicted to kill, on a touched file, are kept', () => {
    expect(witnessMutations(MATRIX, [WITNESS], [FILE]).layers.flatMap(layer => layer.mutations)).toEqual([WITNESS_MUTATION])
    expect(witnessMutations(MATRIX, [], [FILE]).layers).toEqual([])
  })

  it('a branch with no card runs no mutation', async () => {
    const asked: string[][] = []
    const red = async (changed: readonly string[]) => {
      asked.push([...changed])
      return { lines: [], code: 1 }
    }
    expect(await mutationStep([FILE], new Map(), null, { log: () => {}, mutations: red })).toBe(0)
    expect(asked).toEqual([])
  })
})
