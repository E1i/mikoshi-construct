import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { sha256 } from '../src/manifest.js'
import { BLOCK_BEGIN, BLOCK_END } from '../src/materialize/strategies.js'
import { classifyPath } from '../src/sync/classify.js'
import { matchesRecordedSha, ownedKeys, ownedSha, ownedText } from '../src/sync/ownership.js'

const PLACEHOLDER = '_Not discovered yet — run `/construct-discover`._'

function agents(body: string, lead = 'Context for coding agents.'): string {
  return [
    BLOCK_BEGIN,
    '# Project',
    '',
    lead,
    '',
    '## What this product does',
    '',
    '<!-- construct:discover:product -->',
    body,
    '<!-- /construct:discover:product -->',
    BLOCK_END,
    '',
  ].join('\n')
}

function ownerPage(block: string): string {
  return `# The owner's own AGENTS.md\n\nProse the construct never wrote.\n\n${block}\nMore of the owner's prose.\n`
}

describe('what the construct owns inside a file, by strategy', () => {
  it('owns the whole file under create', () => {
    const content = 'export const probe = 1\n'
    expect(ownedText('src/probe.ts', content)).toBe(content)
    expect(ownedSha('src/probe.ts', content)).toBe(ownedSha('src/probe.ts', content))
  })

  it('owns only the construct block under append-block, never the owner prose around it', () => {
    const block = agents(PLACEHOLDER)
    expect(ownedText('AGENTS.md', ownerPage(block))).toBe(ownedText('AGENTS.md', block))
    expect(ownedText('AGENTS.md', ownerPage(block))).not.toContain('Prose the construct never wrote')
  })

  it('owns nothing in a file that carries no construct block', () => {
    expect(ownedText('AGENTS.md', '# Only the owner\n')).toBe('')
  })

  it('excludes the body of every discovery marker, so a placeholder and a filled body are the same owned view', () => {
    const filled = 'The product is a CLI that materializes a construct.'
    expect(ownedText('AGENTS.md', agents(filled))).toBe(ownedText('AGENTS.md', agents(PLACEHOLDER)))
    expect(ownedText('AGENTS.md', agents(filled))).not.toContain(filled)
    expect(ownedText('AGENTS.md', agents(filled))).toContain('<!-- construct:discover:product -->')
  })

  it('excludes marker bodies by the template shape and never by provenance: the classifier reads no authorship at all', () => {
    const source = ['classify.ts', 'ownership.ts']
      .map(file => readFileSync(path.join(import.meta.dirname, '../src/sync', file), 'utf8'))
      .join('\n')
    expect(source).not.toContain('authoredBy')
    expect(source).not.toContain('MarkerProvenance')
    expect(source).not.toContain('DISCOVERY_MARKERS')
  })

  it('classifies both an untouched placeholder and a body discovery filled as keep', () => {
    const produced = agents(PLACEHOLDER)
    const staleRecord = ownedSha('AGENTS.md', agents(PLACEHOLDER, 'Context written by an older template.'))
    for (const present of [agents(PLACEHOLDER), ownerPage(agents('A body somebody filled in.'))])
      expect(classifyPath({ target: 'AGENTS.md', recordedSha: staleRecord, present, produced })?.class).toBe('keep')
  })

  it('reads a record written by sync as the owned view and a record written by init as the whole file', () => {
    const present = ownerPage(agents(PLACEHOLDER))
    expect(ownedSha('AGENTS.md', present)).not.toBe(sha256(present))
    expect(matchesRecordedSha(ownedSha('AGENTS.md', present), 'AGENTS.md', present)).toBe(true)
    expect(matchesRecordedSha(sha256(present), 'AGENTS.md', present)).toBe(true)
    expect(matchesRecordedSha('c0ffee', 'AGENTS.md', present)).toBe(false)
  })
})

describe('what the construct owns in a merge-json target', () => {
  const produced = JSON.stringify({ name: 'demo', scripts: { quality: 'pnpm lint && pnpm test', lint: 'eslint .' } })

  it('owns each key the template produces and nothing else the file carries', () => {
    const present = JSON.stringify({ name: 'demo', description: 'the owner\'s own', scripts: { quality: 'pnpm lint && pnpm test' } })
    expect(ownedKeys(present, produced)).toEqual([
      { key: 'name', class: 'keep' },
      { key: 'scripts.quality', class: 'keep' },
      { key: 'scripts.lint', class: 'add' },
    ])
  })

  it('reports a key whose value differs as conflict, because the record cannot tell an owner edit from a template change', () => {
    const present = JSON.stringify({ name: 'demo', scripts: { quality: 'make check', lint: 'eslint .' } })
    expect(ownedKeys(present, produced)).toEqual([
      { key: 'name', class: 'keep' },
      { key: 'scripts.quality', class: 'conflict' },
      { key: 'scripts.lint', class: 'keep' },
    ])
  })

  it('carries the per-key reading up to the file, and reads unparseable json as conflict', () => {
    const present = JSON.stringify({ name: 'demo', scripts: { quality: 'pnpm lint && pnpm test' } })
    const state = { target: 'package.json', recordedSha: 'recorded', produced }
    expect(classifyPath({ ...state, present })?.class).toBe('update')
    expect(classifyPath({ ...state, present: JSON.stringify(JSON.parse(produced)) })?.class).toBe('keep')
    expect(classifyPath({ ...state, present: '{ not json' })?.class).toBe('conflict')
    expect(classifyPath({ ...state, present })?.keys).toHaveLength(3)
  })
})
