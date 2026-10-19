import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const root = path.resolve(import.meta.dirname, '..')
const RULES_DIR = '.claude/rules'

const BUDGET_CHANGED_ONLY_IN_AN_OWNER_PR: Record<string, number> = {
  'AGENTS.md': 21_716,
  'CLAUDE.md': 2_655,
  '.claude/rules/command-form.md': 478,
  '.claude/rules/conventions.md': 4_176,
  '.claude/rules/secrets.md': 612,
  '.claude/rules/tests.md': 382,
  'architecture/window-core.md': 3_695,
}

const WINDOW_MD = 'architecture/window.md'
const WINDOW_MD_BUDGET_CHANGED_ONLY_IN_AN_OWNER_PR = 57_060

function read(file: string): string {
  return readFileSync(path.join(root, file), 'utf8')
}

function scopedByPaths(text: string): boolean {
  const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(text)
  return frontmatter != null && /^paths:/m.test(frontmatter[1])
}

function alwaysLoadedRules(): string[] {
  return readdirSync(path.join(root, RULES_DIR), { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.md'))
    .map(entry => path.relative(root, path.join(entry.parentPath, entry.name)))
    .filter(file => !scopedByPaths(read(file)))
    .sort()
}

const ALWAYS_LOADED = ['AGENTS.md', 'CLAUDE.md', 'architecture/window-core.md', ...alwaysLoadedRules()]

describe('the always-on text stays inside a fixed budget', () => {
  it.each(ALWAYS_LOADED)('keeps %s within its character budget', (file) => {
    const budget = BUDGET_CHANGED_ONLY_IN_AN_OWNER_PR[file]
    expect(budget, `${file} is loaded in every session and has no budget`).toBeDefined()
    expect(read(file).length).toBeLessThanOrEqual(budget)
  })

  it(`keeps ${WINDOW_MD} within its character budget`, () => {
    expect(read(WINDOW_MD).length).toBeLessThanOrEqual(WINDOW_MD_BUDGET_CHANGED_ONLY_IN_AN_OWNER_PR)
  })

  it('budgets no file that is not loaded in every session', () => {
    expect(Object.keys(BUDGET_CHANGED_ONLY_IN_AN_OWNER_PR).filter(file => !ALWAYS_LOADED.includes(file))).toEqual([])
  })

  it('reads a rule scoped by paths: as loaded with its files, and one without as loaded always', () => {
    expect(scopedByPaths('---\npaths:\n  - "templates/**"\n---\n\n# Templates\n')).toBe(true)
    expect(scopedByPaths('---\ndescription: x\n---\n\n# Tests\n')).toBe(false)
    expect(scopedByPaths('# Tests\n\npaths: are not frontmatter here\n')).toBe(false)
  })

  it('names its version on a line of its own in window-core.md', () => {
    expect(read('architecture/window-core.md').split('\n')).toContain('window-core v3')
  })
})
