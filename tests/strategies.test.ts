import { describe, expect, it } from 'vitest'
import { appendBlock, mergeJson, preserveDiscovery, strategyFor } from '../src/materialize/strategies.js'

describe('strategyFor', () => {
  it('routes manifests, agent files and gitignore to their strategies', () => {
    expect(strategyFor('package.json')).toBe('merge-json')
    expect(strategyFor('CLAUDE.md')).toBe('append-block')
    expect(strategyFor('.gitignore')).toBe('append-block')
    expect(strategyFor('src/app.ts')).toBe('create')
  })
})

describe('mergeJson', () => {
  it('adds missing keys, keeps existing values and reports conflicts', () => {
    const conflicts: string[] = []
    const merged = mergeJson(
      { name: 'mine', scripts: { test: 'jest' } },
      { name: 'theirs', scripts: { test: 'vitest run', lint: 'eslint .' }, devDependencies: { vitest: '^5' } },
      conflicts,
    )
    expect(merged).toEqual({ name: 'mine', scripts: { test: 'jest', lint: 'eslint .' }, devDependencies: { vitest: '^5' } })
    expect(conflicts).toEqual(['name', 'scripts.test'])
  })
})

describe('appendBlock', () => {
  it('wraps a new file in markers and replaces the block on the next run', () => {
    const first = appendBlock('', 'one', 'CLAUDE.md')
    expect(first).toBe('<!-- construct:begin -->\none\n<!-- construct:end -->\n')
    const second = appendBlock(`# Mine\n\n${first}\nTail\n`, 'two', 'CLAUDE.md')
    expect(second).toBe('# Mine\n\n<!-- construct:begin -->\ntwo\n<!-- construct:end -->\n\nTail\n')
  })

  it('appends to an unmarked file without touching it', () => {
    expect(appendBlock('node_modules/\n', 'dist/', '.gitignore')).toBe('node_modules/\n\n# construct:begin\ndist/\n# construct:end\n')
  })
})

describe('preserveDiscovery', () => {
  const placeholder = '<!-- construct:discover:module-map -->\n_Not discovered yet — run `/construct-discover`._\n<!-- /construct:discover:module-map -->'

  it('carries a filled discovery block into the new content', () => {
    const existing = '<!-- construct:discover:module-map -->\n| a | b |\n<!-- /construct:discover:module-map -->'
    expect(preserveDiscovery(existing, `intro\n${placeholder}`)).toBe('intro\n<!-- construct:discover:module-map -->\n| a | b |\n<!-- /construct:discover:module-map -->')
  })

  it('leaves the placeholder when the previous block was never filled', () => {
    expect(preserveDiscovery(placeholder, placeholder)).toBe(placeholder)
  })
})
