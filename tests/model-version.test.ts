import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { MODEL_FILE, MODEL_VERSION, parseModel } from '../src/model/schema.js'

const FIXTURES = path.resolve(import.meta.dirname, 'fixtures/verification')

describe('the model format is version 3', () => {
  it('writes modelVersion 3, which a reader of version 2 reads as ahead of it (0033)', () => {
    expect(MODEL_VERSION).toBe(3)
  })

  it('still reads a version 1 model, which every repository initialised before it carries', () => {
    expect(parseModel(JSON.stringify({ modelVersion: 1, facts: [], claims: [], hypotheses: [] }), MODEL_FILE).modelVersion).toBe(MODEL_VERSION)
  })

  it('still reads the python-service fixture, captured at modelVersion 2 before this bump', () => {
    expect(JSON.parse(readFileSync(path.join(FIXTURES, 'python-service', MODEL_FILE), 'utf8')).modelVersion).toBe(2)
  })

  it('allows a surface only on the report kinds', () => {
    const document = (fact: object): string => JSON.stringify({ modelVersion: 3, facts: [{ id: 'a', path: 'r.json', authoredBy: 'discovery', ...fact }], claims: [], hypotheses: [] })
    expect(() => parseModel(document({ kind: 'file-exists', surface: ['**/*'] }), 'M')).toThrow('facts[0] of kind "file-exists" must not carry a "surface"')
    expect(() => parseModel(document({ kind: 'report-covers' }), 'M')).toThrow('facts[0] of kind "report-covers" needs a "surface" list of non-empty globs')
    expect(() => parseModel(document({ kind: 'report-misses', surface: [] }), 'M')).toThrow('needs a "surface" list of non-empty globs')
    expect(() => parseModel(document({ kind: 'file-lacks' }), 'M')).toThrow('facts[0] of kind "file-lacks" needs a non-empty "needle"')
  })

  it('allows a format only on the report kinds, closed to "vitest-json" and "junit-xml"', () => {
    const document = (fact: object): string => JSON.stringify({ modelVersion: 3, facts: [{ id: 'a', path: 'r.json', authoredBy: 'discovery', ...fact }], claims: [], hypotheses: [] })
    expect(() => parseModel(document({ kind: 'file-exists', format: 'junit-xml' }), 'M')).toThrow('facts[0] of kind "file-exists" must not carry a "format"')
    expect(() => parseModel(document({ kind: 'report-covers', surface: ['**/*'], format: 'cobertura-xml' }), 'M')).toThrow('facts[0] format "cobertura-xml" is not one of vitest-json, junit-xml')
    expect(parseModel(document({ kind: 'report-covers', surface: ['**/*'], format: 'junit-xml' }), 'M').facts[0].format).toBe('junit-xml')
    expect(parseModel(document({ kind: 'report-covers', surface: ['**/*'] }), 'M').facts[0].format).toBeUndefined()
  })
})
