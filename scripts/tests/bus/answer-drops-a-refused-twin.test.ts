import type { DerivedReading, TwinTree } from '../../policy/touch-scope.js'
import { describe, expect, it } from 'vitest'
import { derivedHoldOf, refusedTwinAnswer } from '../../policy/touch-scope.js'

const TOUCHED = 'scripts/nodes/answer/answer-executor.ts'
const SOURCE_OUTSIDE = 'scripts/core/card-bodies.ts'
const FACTORY = 'contract/factory.json'
const RATCHET = 'contract/ratchet.json'
const SCOPE = { touches: [TOUCHED], creates: [] }

interface FakeTree {
  files: Map<string, string | null>
  tree: TwinTree
  reading: DerivedReading
}

function fakeTree(base: Record<string, string>, left: Record<string, string>, generated: (file: string, run: number) => string): FakeTree {
  const files = new Map<string, string | null>(Object.entries({ ...base, ...left }))
  let runs = 0
  const reading: DerivedReading = {
    current: file => files.get(file) ?? null,
    base: file => base[file] ?? null,
    rerun: (_command, outputs) => {
      runs += 1
      return { kind: 'ran', outputs: new Map(outputs.map(file => [file, file in base ? generated(file, runs) : files.get(file) ?? null])) }
    },
  }
  const tree: TwinTree = {
    drop: dropped => dropped.forEach(file => files.set(file, base[file] ?? null)),
    reading: () => reading,
    write: (file, text) => files.set(file, text),
  }
  return { files, tree, reading }
}

describe('the answer node drops a refused generated twin and regenerates it', () => {
  it('the answer node drops a refused contract/factory.json, regenerates it from the sources in the touches and opens no owner wait', () => {
    const fake = fakeTree({ [FACTORY]: '{"v":1}\n' }, { [FACTORY]: '{"v":"hand"}\n' }, () => '{"v":2}\n')

    const answer = refusedTwinAnswer([FACTORY], SCOPE, fake.tree, [TOUCHED, FACTORY])

    expect(answer).toEqual({ kind: 'regenerated', files: [FACTORY], rest: [] })
    expect(fake.files.get(FACTORY)).toBe('{"v":2}\n')
  })

  it('a regenerated twin whose generator does not reproduce it names the source outside the touches to the window', () => {
    const fake = fakeTree({ [FACTORY]: '{"v":1}\n' }, { [FACTORY]: '{"v":"hand"}\n' }, (_file, run) => `{"v":${run}}\n`)

    const answer = refusedTwinAnswer([FACTORY], SCOPE, fake.tree, [TOUCHED, SOURCE_OUTSIDE, FACTORY])

    expect(answer).toMatchObject({ kind: 'window', twins: [FACTORY], sources: [SOURCE_OUTSIDE] })
  })

  it('a ratchet row the answer grows still stops for the owner', () => {
    const fake = fakeTree({ [RATCHET]: '{"lines:x":1}\n' }, { [RATCHET]: '{"lines:x":2}\n' }, () => '{"lines:x":2}\n')

    expect(derivedHoldOf(SCOPE, [RATCHET], () => fake.reading)).toMatchObject({ kind: 'grown', detail: expect.stringContaining(RATCHET) })
    expect(fake.files.get(RATCHET)).toBe('{"lines:x":2}\n')
  })
})
