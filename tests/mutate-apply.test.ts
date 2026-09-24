import { Buffer } from 'node:buffer'
import { readFileSync, utimesSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyMutation, runJudge } from '../src/commands/mutate/index.js'
import { sha256 } from '../src/commands/mutate/record.js'
import { MutateWorld, passing } from './mutate-world.js'

const SOURCE = 'src/limit.ts'
const ORIGINAL = 'export function within(a: number, b: number): boolean {\n  return a < b\n}\n'
const LINE = 'M1 | src/limit.ts | find: `a < b` → `a <= b` | red: tests/limit.test.ts › within › is strict | `expected true to be false`'

function world(source = ORIGINAL): MutateWorld {
  const w = new MutateWorld()
  w.write(SOURCE, source)
  return w
}

function withGreenBaseline(w: MutateWorld): MutateWorld {
  const report = w.report('green.json', Date.now(), [passing('tests/limit.test.ts', 'within', 'is strict')])
  expect(runJudge({ dir: w.root, report, baseline: true }).status).toBe('baseline-recorded')
  return w
}

describe('mutate apply', () => {
  it('writes the replacement, keeps the original bytes as a copy and records both shas', () => {
    const w = withGreenBaseline(world())
    const result = applyMutation({ dir: w.root, from: w.brief([LINE]), id: 'M1' })

    expect(result.status).toBe('applied')
    const mutated = 'export function within(a: number, b: number): boolean {\n  return a <= b\n}\n'
    expect(w.bytes(SOURCE).toString()).toBe(mutated)
    expect(w.bytes('.construct/mutations/M1.orig').toString()).toBe(ORIGINAL)
    const record = JSON.parse(readFileSync(path.join(w.root, '.construct/mutations/M1.json'), 'utf8')) as Record<string, unknown>
    expect(record).toMatchObject({
      id: 'M1',
      file: SOURCE,
      baselineSha: sha256(Buffer.from(ORIGINAL)),
      mutatedSha: sha256(Buffer.from(mutated)),
      prediction: { kind: 'test', file: 'tests/limit.test.ts', titles: ['within', 'is strict'] },
    })
    expect(typeof record.appliedAt).toBe('number')
  })

  it('refuses when find occurs twice and leaves the file unchanged', () => {
    const twice = `${ORIGINAL}export const alsoWithin = (a: number, b: number): boolean => a < b\n`
    const w = withGreenBaseline(world(twice))
    const result = applyMutation({ dir: w.root, from: w.brief([LINE]), id: 'M1' })

    expect(result).toMatchObject({ status: 'refused', refusal: 'find-count', detail: '2' })
    expect(w.bytes(SOURCE).toString()).toBe(twice)
    expect(w.mutations()).toEqual(['baseline.json'])
  })

  it('refuses without a green baseline and leaves the file unchanged', () => {
    const w = world()
    const result = applyMutation({ dir: w.root, from: w.brief([LINE]), id: 'M1' })

    expect(result).toMatchObject({ status: 'refused', refusal: 'no-baseline' })
    expect(w.bytes(SOURCE).toString()).toBe(ORIGINAL)
    expect(w.mutations()).toEqual([])
  })

  it('refuses when the file was modified after the green run started', () => {
    const w = withGreenBaseline(world())
    const later = new Date(Date.now() + 60_000)
    utimesSync(path.join(w.root, SOURCE), later, later)
    const result = applyMutation({ dir: w.root, from: w.brief([LINE]), id: 'M1' })

    expect(result).toMatchObject({ status: 'refused', refusal: 'changed-after-baseline' })
    expect(w.bytes(SOURCE).toString()).toBe(ORIGINAL)
    expect(w.mutations()).toEqual(['baseline.json'])
  })

  it('refuses an edit: line, written before the code existed', () => {
    const w = withGreenBaseline(world())
    const result = applyMutation({ dir: w.root, from: w.brief(['M2 | src/limit.ts | edit: make the bound inclusive | red: tests/limit.test.ts › within › is strict']), id: 'M2' })

    expect(result).toMatchObject({ status: 'refused', refusal: 'edit-line' })
    expect(w.bytes(SOURCE).toString()).toBe(ORIGINAL)
    expect(w.mutations()).toEqual(['baseline.json'])
  })

  it('refuses an id no line of the brief carries', () => {
    const w = withGreenBaseline(world())
    const result = applyMutation({ dir: w.root, from: w.brief([LINE]), id: 'M9' })

    expect(result).toMatchObject({ status: 'refused', refusal: 'unknown-id' })
    expect(w.bytes(SOURCE).toString()).toBe(ORIGINAL)
  })
})
