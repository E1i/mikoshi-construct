import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { FACTORY_WORKERS } from '../../core/factory-paths.js'
import * as rootExports from '../../nodes/launch/launch-root.js'
import { LaunchNode } from '../../nodes/launch/launch-worker.js'

const REPOSITORY = path.resolve(import.meta.dirname, '..', '..', '..')
const ROOT_FILE = 'scripts/nodes/launch/launch-root.ts'
const NODE_FILE = 'scripts/nodes/launch/launch-worker.ts'
const NODE_SUBCLASS = /\bclass\s+\w+\s+extends\s+Node\b/
const EVENT_QUERY = /\bFROM\s+(?:events|tasks|cards)\b/
const ENTRY_GUARD = /process\.argv\[1\]/
const SPAWN_IMPORT = /from\s+'node:child_process'/
const ROOT_IMPORT = /from\s+'\.\/launch-root\.js'/

function source(file: string): string {
  return readFileSync(path.join(REPOSITORY, file), 'utf8')
}

describe('the composition root of launch holds no node logic', () => {
  it('the root declares no node and queries no bus table of its own beyond the sessions of a card', () => {
    const root = source(ROOT_FILE)
    expect(root).not.toMatch(NODE_SUBCLASS)
    expect(root.match(new RegExp(EVENT_QUERY, 'g')) ?? []).toHaveLength(1)
    expect(root).toMatch(ENTRY_GUARD)
  })

  it('the node holds the launch node, no entry, no spawn and no import of its root', () => {
    const node = source(NODE_FILE)
    expect(node).toMatch(NODE_SUBCLASS)
    expect(node).not.toMatch(ENTRY_GUARD)
    expect(node).not.toMatch(SPAWN_IMPORT)
    expect(node).not.toMatch(ROOT_IMPORT)
  })

  it('the factory starts launch from its root', () => {
    expect(FACTORY_WORKERS.launch).toBe(ROOT_FILE)
    expect(Object.keys(rootExports)).not.toContain(LaunchNode.name)
  })
})
