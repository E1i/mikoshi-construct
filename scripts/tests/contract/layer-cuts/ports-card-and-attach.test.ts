import { describe, expect, it } from 'vitest'
import { repositoryReport } from '../../../contract/module-graph/report.js'
import { conflictingCardOf } from '../../../ports/main-merge.js'

const MAIN_MERGE = 'scripts/ports/main-merge.ts'
const CARD_BODIES = 'scripts/core/card-bodies.ts'
const SNAPSHOT = 'scripts/ports/snapshot.ts'
const ATTACH_RECORD = 'src/commands/attach/record.ts'

describe('the ports take the card body and the attach record from above', () => {
  it('repositoryReport() holds no import from main-merge.ts to card-bodies.ts and none from snapshot.ts to attach/record.ts', () => {
    const { graph } = repositoryReport()
    const upward = graph.imports.filter(({ from, to }) => (from === MAIN_MERGE && to === CARD_BODIES) || (from === SNAPSHOT && to === ATTACH_RECORD))
    expect(upward).toEqual([])
  })

  it('the conflicting card asks the predicate it was given about its own card', () => {
    const asked: [number, readonly string[]][] = []
    const card = conflictingCardOf((cardId, files) => {
      asked.push([cardId, files])
      return files.filter(file => file.startsWith('outside/'))
    }, 2112, 'feat/x', 'a'.repeat(40))
    expect(card.outsideTheCard(['outside/a.ts', 'inside/b.ts'])).toEqual(['outside/a.ts'])
    expect(asked).toEqual([[2112, ['outside/a.ts', 'inside/b.ts']]])
  })
})
