import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { writeEngram } from '../src/model/discovery.js'
import { MODEL_FILE, MODEL_VERSION, parseModel } from '../src/model/schema.js'
import { mergeModel } from '../src/model/write.js'

const LAYER = {
  authoredBy: 'discovery',
  components: [
    { id: 'pricing', contour: '.', name: 'Pricing', purpose: 'Computes what an order costs', files: ['src/price.ts', 'src/tax.ts'] },
    { id: 'orders', contour: '.', name: 'Orders', purpose: 'Takes an order and stores it', files: ['src/orders.ts'] },
  ],
}

function documentWith(interpretation: unknown): string {
  return JSON.stringify({ modelVersion: MODEL_VERSION, facts: [], claims: [], hypotheses: [], interpretation })
}

describe('the interpretation layer is a closed shape the CLI checks and never authors', () => {
  it('reads the layer an agent wrote beside the mechanics', () => {
    expect(parseModel(documentWith(LAYER), MODEL_FILE).interpretation).toEqual(LAYER)
  })

  it('reads a document without the layer as having none', () => {
    expect(parseModel(JSON.stringify({ modelVersion: MODEL_VERSION, facts: [], claims: [], hypotheses: [] }), MODEL_FILE).interpretation).toBeUndefined()
  })

  it('refuses a confidence, or any property it does not know, naming where it stands', () => {
    expect(() => parseModel(documentWith({ ...LAYER, confidence: 0.9 }), 'M')).toThrow(/interpretation.*confidence/)
    expect(() => parseModel(documentWith({ ...LAYER, components: [{ ...LAYER.components[0], confidence: 0.9 }] }), 'M')).toThrow(/interpretation\.components\[0\].*confidence/)
  })

  it('refuses a file two components hold, because a file belongs to one component', () => {
    const twice = { ...LAYER, components: [...LAYER.components, { id: 'tax', contour: '.', name: 'Tax', purpose: 'Tax', files: ['src/tax.ts'] }] }
    expect(() => parseModel(documentWith(twice), 'M')).toThrow('interpretation.components[2] names "src/tax.ts", which an earlier component already holds')
  })

  it('refuses a component without a purpose and a layer whose author is not one it knows', () => {
    expect(() => parseModel(documentWith({ ...LAYER, components: [{ ...LAYER.components[0], purpose: undefined }] }), 'M')).toThrow(/purpose/)
    expect(() => parseModel(documentWith({ ...LAYER, authoredBy: 'llm' }), 'M')).toThrow('interpretation authoredBy "llm" is not one of construct, discovery, unknown')
  })
})

describe('the layer survives the writers that rewrite the document around it', () => {
  it('keeps the layer when init merges a fresh model into the existing one', () => {
    const existing = parseModel(documentWith(LAYER), MODEL_FILE)
    const fresh = parseModel(JSON.stringify({ modelVersion: MODEL_VERSION, facts: [], claims: [], hypotheses: [] }), MODEL_FILE)
    expect(mergeModel(existing, fresh).model.interpretation).toEqual(LAYER)
  })

  it('keeps the layer when discovery replaces the mechanics, and leaves the mechanics as discovery found them', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'model-interpretation-'))
    const root = mkdtempSync(path.join(tmpdir(), 'model-interpretation-root-'))
    const mechanics = { identity: { sha: null, status: 'unknown' as const, source: { command: 'git rev-parse HEAD', exit: null, effects: [] } }, tree: { status: 'unknown' as const, source: { command: 'git ls-files -z', exit: null, effects: [] } }, contours: [], components: [], relations: [] }
    const file = writeEngram(root, { attached: true, home }, mechanics)
    const written = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    writeFileSync(file, `${JSON.stringify({ ...written, interpretation: LAYER }, null, 2)}\n`)
    writeEngram(root, { attached: true, home }, mechanics)
    const again = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    expect(again.interpretation).toEqual(LAYER)
    expect(again.mechanics).toEqual(written.mechanics)
  })
})
