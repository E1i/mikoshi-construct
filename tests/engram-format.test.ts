import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { LINK_PROPERTIES, NODE_PROPERTIES, NODE_SOURCE_PROPERTIES, STAGE_PROPERTIES } from '../src/model/schema.js'
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

  it('reports an invented member', () => {
    expect(unexplained([...MEMBERS, 'inventedProperty'])).toEqual(['inventedProperty'])
  })

  it('writes empty lists at birth', () => {
    const model = buildModel({ vars: { harnessCommand: 'pnpm run quality', contractPath: 'c.yaml' } as never, contracts: false, sample: false })
    expect([model.stages, model.nodes, model.links]).toEqual([[], [], []])
  })
})
