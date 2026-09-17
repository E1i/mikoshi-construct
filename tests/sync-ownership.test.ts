import type { EstablishedVariant } from '../src/sync/variant.js'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { sha256 } from '../src/manifest.js'
import { BLOCK_BEGIN, BLOCK_END } from '../src/materialize/strategies.js'
import { BLOCK_REPLACED_WHOLE_DISCOVERY_BODIES_CARRIED_OVER, classifyPath } from '../src/sync/classify.js'
import { matchesRecordedSha, ownedKeys, ownedSha, ownedText } from '../src/sync/ownership.js'

const RECORDED_BY_INIT: EstablishedVariant = { variant: 'existing', evidence: 'recorded' }

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
      expect(classifyPath({ target: 'AGENTS.md', recordedSha: staleRecord, present, produced, variant: RECORDED_BY_INIT })?.class).toBe('keep')
  })

  it('reads a block differing from what the templates produce as update, though discovery filled the markers outside the record', () => {
    const produced = agents(PLACEHOLDER, 'Context written by today\'s template.')
    const present = ownerPage(agents('A body discovery filled in.', 'Context written by an older template.'))
    const recordedByInit = sha256(ownerPage(agents(PLACEHOLDER, 'Context written by an older template.')))
    expect(matchesRecordedSha(recordedByInit, 'AGENTS.md', present)).toBe(false)

    const classification = classifyPath({ target: 'AGENTS.md', recordedSha: recordedByInit, present, produced, variant: RECORDED_BY_INIT })
    expect(classification?.class).toBe('update')
    expect(classification?.class).not.toBe('conflict')
  })

  it('never consults the recorded sha of an append-block target, whatever the record says', () => {
    const produced = agents(PLACEHOLDER, 'Context written by today\'s template.')
    const present = ownerPage(agents(PLACEHOLDER, 'Context written by an older template.'))
    for (const recordedSha of [sha256(present), ownedSha('AGENTS.md', present), 'a sha nothing hashes to'])
      expect(classifyPath({ target: 'AGENTS.md', recordedSha, present, produced, variant: RECORDED_BY_INIT })?.class).toBe('update')
  })

  it('reads a recorded file the owner stripped the delimiters from as conflict, never as add or update', () => {
    const produced = agents(PLACEHOLDER)
    const declarationCutOut = '# The owner\'s own AGENTS.md\n\nProse the construct never wrote.\n'
    const classification = classifyPath({ target: 'AGENTS.md', recordedSha: sha256(ownerPage(produced)), present: declarationCutOut, produced, variant: RECORDED_BY_INIT })
    expect(classification?.class).toBe('conflict')
    expect(['add', 'update']).not.toContain(classification?.class)
  })

  it('carries on a block it will write that the block is replaced whole and discovery bodies are carried over', () => {
    const produced = agents(PLACEHOLDER, 'Context written by today\'s template.')
    const present = ownerPage(agents('A body discovery filled in.', 'Context written by an older template.'))
    const update = classifyPath({ target: 'AGENTS.md', recordedSha: sha256(present), present, produced, variant: RECORDED_BY_INIT })
    expect(update?.class).toBe('update')
    expect(update?.writeEffect).toBe(BLOCK_REPLACED_WHOLE_DISCOVERY_BODIES_CARRIED_OVER)
    expect(classifyPath({ target: 'AGENTS.md', recordedSha: sha256(produced), present: produced, produced, variant: RECORDED_BY_INIT })?.writeEffect).toBeNull()
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
