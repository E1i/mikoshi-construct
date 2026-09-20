import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { upgradeManifest } from '../src/manifest.js'
import { parseModel } from '../src/model/schema.js'

const MANIFESTS = path.resolve(import.meta.dirname, 'fixtures/manifests')
const MODEL = path.resolve(import.meta.dirname, 'fixtures/model')

const REPOSITORY_KNOWLEDGE_KEYS = ['facts', 'claims', 'hypotheses', 'enforcement', 'verification', 'supportedBy']

function knowledgeKeysIn(record: unknown): string[] {
  if (Array.isArray(record))
    return record.flatMap(knowledgeKeysIn)
  if (typeof record !== 'object' || record == null)
    return []
  return Object.entries(record).flatMap(([key, value]) => [
    ...REPOSITORY_KNOWLEDGE_KEYS.includes(key) ? [key] : [],
    ...knowledgeKeysIn(value),
  ])
}

function manifestFolders(): string[] {
  return readdirSync(MANIFESTS, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
}

describe('construct.json and the model are separate authorities', () => {
  it('keeps repository knowledge out of every recorded manifest', () => {
    expect(manifestFolders().length).toBeGreaterThan(3)
    for (const folder of manifestFolders()) {
      const manifest = upgradeManifest(JSON.parse(readFileSync(path.join(MANIFESTS, folder, 'construct.json'), 'utf8')))
      expect(knowledgeKeysIn(manifest), `${folder}: a claim in the manifest is a second source for what the model owns`).toEqual([])
    }
  })

  it('names the knowledge key a manifest must not carry', () => {
    const withClaims = { ...JSON.parse(readFileSync(path.join(MANIFESTS, manifestFolders()[0], 'construct.json'), 'utf8')), claims: [{ id: 'no-committed-secret' }] }
    expect(knowledgeKeysIn(upgradeManifest(withClaims))).toEqual(['claims'])
  })

  it('keeps file provenance out of the model', () => {
    const fresh = readFileSync(path.join(MODEL, 'fresh-init/construct.model.json'), 'utf8')
    expect(parseModel(fresh, 'F1').facts.length).toBeGreaterThan(0)
    expect(() => parseModel(readFileSync(path.join(MODEL, 'rejected/file-hashes.json'), 'utf8'), 'file-hashes')).toThrow('unexpected property "files"')
  })
})
