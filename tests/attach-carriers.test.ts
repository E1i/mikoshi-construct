import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { planCarriers } from '../src/commands/attach/index.js'
import { strategyFor } from '../src/materialize/strategies.js'
import { ATTACH_CARRIERS } from '../src/presets/index.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const ATTACH_RECORD = '.construct/attach.json'

const CARRIED_SCRIPT = /scripts\/construct\/[\w.-]+\.mjs/g

const SCRIPTS = [
  'scripts/construct/implement.workflow.mjs',
  'scripts/construct/check-acceptance.mjs',
  'scripts/construct/contract-paths.mjs',
]

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
  })

  it('keeps this repository\'s scripts byte-identical to the template copies', () => {
    for (const file of SCRIPTS)
      expect(readFileSync(path.join(REPO_ROOT, file)).equals(readFileSync(path.join(REPO_ROOT, 'templates/ai/claude', file))), file).toBe(true)
  })
})

describe('the carrier set is exactly what attach may write', () => {
  it('names eight targets, every one created whole and never merged or appended', () => {
    expect(ATTACH_CARRIERS.targets).toHaveLength(8)
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

describe('the carriers are complete and documented', () => {
  it('carries every script the carried commands run', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'attach-carriers-'))
    try {
      const targets: readonly string[] = ATTACH_CARRIERS.targets
      const named = planCarriers(dir, 'pnpm test')
        .filter(op => op.target.endsWith('.md'))
        .flatMap(op => op.content.match(CARRIED_SCRIPT) ?? [])
      expect(named).toContain('scripts/construct/check-acceptance.mjs')
      expect(named).toContain('scripts/construct/contract-paths.mjs')
      for (const script of new Set(named))
        expect(targets, script).toContain(script)
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('is named target by target in docs/cli.md', () => {
    const doc = read('docs/cli.md')
    for (const target of ATTACH_CARRIERS.targets)
      expect(doc, target).toContain(`\`${target}\``)
  })
})
