import { describe, expect, it } from 'vitest'
import { appendBlock, mergeJson, preserveDiscovery, strategyFor, substituteBlock } from '../src/materialize/strategies.js'

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

  it('keeps its own heading a heading on a re-run, because the H1 it would be demoting is the one it wrote', () => {
    const first = appendBlock('', '# Project\n\nbody', 'AGENTS.md')
    expect(first).toContain('# Project')
    expect(appendBlock(first, '# Project\n\nbody', 'AGENTS.md')).toBe(first)
  })

  it('still demotes its heading under an H1 the document carries outside the block', () => {
    const owned = appendBlock('# Theirs\n\ntheir prose\n', '# Project\n\nbody', 'AGENTS.md')
    expect(owned).toContain('## Project')
    expect(appendBlock(owned, '# Project\n\nbody', 'AGENTS.md')).toBe(owned)
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

describe('substituteBlock', () => {
  const produced = '<!-- construct:begin -->\n# Produced\n\nnew\n<!-- construct:end -->\n'
  const existing = '# Mine\n\nmy prose\n\n<!-- construct:begin -->\n## Produced\n\nold\n<!-- construct:end -->\n\nmy tail\n'

  it('substitutes only between the present file\'s own markers and keeps every byte around them', () => {
    expect(substituteBlock(existing, produced, 'CLAUDE.md')).toBe('# Mine\n\nmy prose\n\n<!-- construct:begin -->\n# Produced\n\nnew\n<!-- construct:end -->\n\nmy tail\n')
  })

  it('writes what was compared: the block it leaves behind reads back as the produced one, where appendBlock demotes the heading and no longer does', () => {
    const owned = (content: string): string => content.slice(content.indexOf('<!-- construct:begin -->'), content.indexOf('<!-- construct:end -->'))
    expect(owned(substituteBlock(existing, produced, 'CLAUDE.md'))).toBe(owned(produced))
    expect(owned(appendBlock(existing, produced.slice(produced.indexOf('\n') + 1, produced.lastIndexOf('<!-- construct:end -->')), 'CLAUDE.md'))).not.toBe(owned(produced))
  })

  it('carries a filled discovery body over into the block it writes', () => {
    const filled = '<!-- construct:begin -->\n<!-- construct:discover:product -->\nwhat we ship\n<!-- /construct:discover:product -->\n<!-- construct:end -->\n'
    const placeholder = '<!-- construct:begin -->\n<!-- construct:discover:product -->\n_Not discovered yet — run `/construct-discover`._\n<!-- /construct:discover:product -->\nand a new line\n<!-- construct:end -->\n'
    const written = substituteBlock(filled, placeholder, 'AGENTS.md')
    expect(written).toContain('what we ship')
    expect(written).toContain('and a new line')
    expect(written).not.toContain('_Not discovered yet')
  })

  it('reads the gitignore markers for a gitignore target', () => {
    expect(substituteBlock('node_modules/\n\n# construct:begin\nold\n# construct:end\n', '# construct:begin\ndist/\n# construct:end\n', '.gitignore'))
      .toBe('node_modules/\n\n# construct:begin\ndist/\n# construct:end\n')
  })
})
