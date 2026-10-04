import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseModel } from '../src/model/schema.js'
import { deriveModelState } from '../src/model/state.js'

function node(id: string, supportedBy: string[]): object {
  return { id, label: id, stage: 's1', source: { path: 'present.txt' }, supportedBy }
}

function document(): string {
  return JSON.stringify({
    modelVersion: 4,
    facts: [
      { id: 'there', kind: 'file-exists', path: 'present.txt', authoredBy: 'discovery' },
      { id: 'absent', kind: 'file-exists', path: 'absent.txt', authoredBy: 'discovery' },
    ],
    claims: [],
    hypotheses: [],
    stages: [{ id: 's1', label: 'One' }],
    nodes: [node('held', ['there']), node('unsupported', ['absent']), node('unknown', [])],
    links: [],
  })
}

describe('a node state is derived from its facts and never stored', () => {
  it('reads held, unsupported and unknown for a present file, an absent file and no fact', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'engram-state-'))
    writeFileSync(path.join(root, 'present.txt'), 'x\n')
    const { nodes } = deriveModelState(parseModel(document(), 'M'), root)
    expect(nodes.held?.state).toBe('held')
    expect(nodes.unsupported?.state).toBe('unsupported')
    expect(nodes.unknown?.state).toBe('unknown')
  })

  it('holds no state key in the parsed model', () => {
    expect(JSON.stringify(parseModel(document(), 'M'))).not.toContain('"state"')
  })

  it('refuses a node that carries a state property', () => {
    const raw = JSON.parse(document())
    raw.nodes[0].state = 'held'
    expect(() => parseModel(JSON.stringify(raw), 'M')).toThrow('nodes[0] carries an unexpected property "state"')
  })
})
