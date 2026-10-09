import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { COMMAND_SOURCE_PROPERTIES, COMPONENT_PROPERTIES, CONTOUR_PROPERTIES, IDENTITY_PROPERTIES, INTERPRETATION_PROPERTIES, INTERPRETED_COMPONENT_PROPERTIES, LINE_SOURCE_PROPERTIES, LINK_PROPERTIES, MECHANICS_PROPERTIES, NODE_PROPERTIES, NODE_SOURCE_PROPERTIES, RELATION_PROPERTIES, STAGE_PROPERTIES, TREE_PROPERTIES } from '../src/model/schema.js'
import { buildModel } from '../src/model/write.js'

const DOCUMENT = readFileSync(path.join(import.meta.dirname, '../architecture/engram.md'), 'utf8')

const MEMBERS = [...STAGE_PROPERTIES, ...NODE_PROPERTIES, ...NODE_SOURCE_PROPERTIES, ...LINK_PROPERTIES]

function unexplained(members: readonly string[]): string[] {
  return members.filter(member => !DOCUMENT.includes(`| \`${member}\` |`))
}

describe('architecture/engram.md explains every property the engram lists use', () => {
  it('names all eleven members with what each means beside it', () => {
    expect(MEMBERS).toHaveLength(11)
    expect(unexplained(MEMBERS)).toEqual([])
  })

  it('names every property of the mechanics discovery writes', () => {
    const mechanics = [...MECHANICS_PROPERTIES, ...IDENTITY_PROPERTIES, ...TREE_PROPERTIES, ...COMMAND_SOURCE_PROPERTIES, ...LINE_SOURCE_PROPERTIES, ...COMPONENT_PROPERTIES, ...RELATION_PROPERTIES]
    expect(unexplained(mechanics)).toEqual([])
  })

  it('names every property of the contours discovery writes and of the interpretation layer an agent writes', () => {
    expect(unexplained([...CONTOUR_PROPERTIES, ...INTERPRETATION_PROPERTIES, ...INTERPRETED_COMPONENT_PROPERTIES])).toEqual([])
  })

  it('reports an invented member', () => {
    expect(unexplained([...MEMBERS, 'inventedProperty'])).toEqual(['inventedProperty'])
  })

  it('writes empty lists at birth', () => {
    const model = buildModel({ vars: { harnessCommand: 'pnpm run quality', contractPath: 'c.yaml' } as never, contracts: false, sample: false })
    expect([model.stages, model.nodes, model.links]).toEqual([[], [], []])
  })
})
