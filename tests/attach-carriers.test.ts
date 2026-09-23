import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { strategyFor } from '../src/materialize/strategies.js'
import { ATTACH_CARRIERS } from '../src/presets/index.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const ATTACH_RECORD = '.construct/attach.json'

const RE_KEYED_TEMPLATES = [
  'templates/ai/claude/_claude/skills/implement/SKILL.md',
  'templates/ai/claude/_claude/agents/harness.md',
  'templates/ai/claude/_claude/agents/architect.md',
]

function read(file: string): string {
  return readFileSync(path.join(REPO_ROOT, file), 'utf8')
}

describe('the carried commands read the attach record when there is no construct.json', () => {
  for (const file of RE_KEYED_TEMPLATES) {
    it(`${file} names ${ATTACH_RECORD}`, () => {
      expect(read(file)).toContain(ATTACH_RECORD)
    })
  }

  it('keeps this repository\'s own copies identical to the templates', () => {
    for (const file of RE_KEYED_TEMPLATES)
      expect(read(file.replace('templates/ai/claude/_claude/', '.claude/')), file).toBe(read(file))
    expect(read('scripts/construct/implement.workflow.mjs')).toBe(read('templates/ai/claude/scripts/construct/implement.workflow.mjs'))
  })
})

describe('the carrier set is exactly what attach may write', () => {
  it('names six targets, every one created whole and never merged or appended', () => {
    expect(ATTACH_CARRIERS.targets).toHaveLength(6)
    for (const target of ATTACH_CARRIERS.targets)
      expect(strategyFor(target), target).toBe('create')
  })

  it('carries no rule and not the discovery protocol, which govern or write into the tree', () => {
    for (const target of ATTACH_CARRIERS.targets) {
      expect(target.startsWith('.claude/rules/'), target).toBe(false)
      expect(target.endsWith('construct-discover.md'), target).toBe(false)
    }
  })

  it('comes from the two groups that ship the Claude Code carriers', () => {
    expect([...ATTACH_CARRIERS.groups]).toEqual(['ai/shared', 'ai/claude'])
  })
})
