import type { SliceSources } from '../../src/card/slice-depends.js'
import { describe, expect, it } from 'vitest'
import { dependsCycle, sliceDepends } from '../../src/card/slice-depends.js'

function sources(files: Record<string, string>): SliceSources {
  return {
    read: relative => files[relative] ?? null,
    filesUnder: directory => Object.keys(files).filter(file => file.startsWith(`${directory}/`)),
  }
}

describe('sliceDepends', () => {
  it('a slice whose file imports a file of another slice depends on that slice, with .js read as its .ts source', () => {
    const files = sources({ 'scripts/bus/queue.ts': 'import { roundLimitDecisionOf } from \'./round-limit-decision.js\'\n' })
    expect(sliceDepends([['scripts/bus/queue.ts'], ['scripts/bus/round-limit-decision.ts']], files)).toEqual([[1], []])
  })

  it('reads every file under a glob touch and resolves a parent-relative import into a glob of another slice', () => {
    const files = sources({ 'src/commands/detach/index.ts': 'export { lore } from \'../../ui/lore.js\'\n' })
    expect(sliceDepends([['src/commands/detach/**'], ['src/ui/**'], ['docs/cli.md']], files)).toEqual([[1], [], []])
  })

  it('an import inside one slice, a package import or an unread file makes no depends', () => {
    const files = sources({ 'src/a.ts': 'import { b } from \'./b.js\'\nimport path from \'node:path\'\n' })
    expect(sliceDepends([['src/a.ts', 'src/b.ts'], ['src/missing.ts']], files)).toEqual([[], []])
  })
})

describe('dependsCycle', () => {
  it('names the slices of a cycle and finds none in an order that holds', () => {
    expect(dependsCycle([[1], [2], [0]])).toEqual([0, 1, 2])
    expect(dependsCycle([[1], [], [0, 1]])).toBeNull()
  })
})
