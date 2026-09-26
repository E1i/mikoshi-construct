import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { MODEL_FILE, MODEL_VERSION, parseModel } from '../src/model/schema.js'

const FIXTURES = path.resolve(import.meta.dirname, 'fixtures/verification')

describe('the model format is version 2', () => {
  it('writes modelVersion 2, which a reader of version 1 reads as ahead of it (0028)', () => {
    expect(MODEL_VERSION).toBe(2)
    expect(JSON.parse(readFileSync(path.join(FIXTURES, 'python-service', MODEL_FILE), 'utf8')).modelVersion).toBe(2)
  })

  it('still reads a version 1 model, which every repository initialised before it carries', () => {
    expect(parseModel(JSON.stringify({ modelVersion: 1, facts: [], claims: [], hypotheses: [] }), MODEL_FILE).modelVersion).toBe(MODEL_VERSION)
  })

  it('allows a surface only on the report kinds', () => {
    const document = (fact: object): string => JSON.stringify({ modelVersion: 2, facts: [{ id: 'a', path: 'r.json', authoredBy: 'discovery', ...fact }], claims: [], hypotheses: [] })
    expect(() => parseModel(document({ kind: 'file-exists', surface: ['**/*'] }), 'M')).toThrow('facts[0] of kind "file-exists" must not carry a "surface"')
    expect(() => parseModel(document({ kind: 'report-covers' }), 'M')).toThrow('facts[0] of kind "report-covers" needs a "surface" list of non-empty globs')
    expect(() => parseModel(document({ kind: 'report-misses', surface: [] }), 'M')).toThrow('needs a "surface" list of non-empty globs')
    expect(() => parseModel(document({ kind: 'file-lacks' }), 'M')).toThrow('facts[0] of kind "file-lacks" needs a non-empty "needle"')
  })
})
