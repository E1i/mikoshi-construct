import type { ContourSchema } from '../../contract/contours.js'
import { describe, expect, it } from 'vitest'
import { contourSchemaNames, readContourSchema, schemaId, violations } from '../../contract/contours.js'

const DIALECT = 'https://json-schema.org/draft/2020-12/schema'

describe('the contour schemas', () => {
  it('lists the two schemas, each with the dialect, a versioned $id ending in its name and a description', () => {
    expect(contourSchemaNames()).toEqual(['ledger-row', 'review-verdict'])
    for (const name of contourSchemaNames()) {
      const schema = readContourSchema(name) as ContourSchema & { $schema: string, description: string }
      expect(schema.$schema).toBe(DIALECT)
      expect(schemaId(schema)).toMatch(new RegExp(`^mikoshi-construct/contours/${name}/\\d+(?:\\.\\d+)?$`))
      expect(schema.description.length).toBeGreaterThan(0)
    }
  })

  it('refuses a schema with no $id', () => {
    expect(() => schemaId({})).toThrow('no $id')
  })
})

describe('violations', () => {
  it('checks type, and names the path', () => {
    expect(violations('a', { type: 'number' })).toEqual(['value: expected number'])
    expect(violations(null, { type: 'null' })).toEqual([])
    expect(violations(1.5, { type: 'integer' })).toEqual(['value: expected integer'])
    expect(violations([], { type: 'object' })).toEqual(['value: expected object'])
    expect(violations({ a: { b: [1, 'x'] } }, { type: 'object', properties: { a: { type: 'object', properties: { b: { type: 'array', items: { type: 'number' } } } } } })).toEqual(['a.b[1]: expected number'])
  })

  it('checks required, properties and items', () => {
    const schema: ContourSchema = { type: 'object', required: ['a', 'b'], properties: { b: { type: 'array', items: { type: 'object', required: ['c'] } } } }
    expect(violations({ b: [{}] }, schema)).toEqual(['a: missing', 'b[0].c: missing'])
    expect(violations({ a: 1, b: [{ c: 1 }] }, schema)).toEqual([])
  })

  it('checks enum, const, pattern and minLength', () => {
    expect(violations('c', { enum: ['a', 'b'] })).toEqual(['value: expected one of "a", "b"'])
    expect(violations('b', { enum: ['a', 'b'] })).toEqual([])
    expect(violations('y', { const: 'x' })).toEqual(['value: expected "x"'])
    expect(violations('abc', { type: 'string', pattern: '^[0-9]+$' })).toEqual(['value: does not match ^[0-9]+$'])
    expect(violations('', { type: 'string', minLength: 1 })).toEqual(['value: shorter than 1'])
  })

  it('checks anyOf, allOf, if/then/else and not', () => {
    expect(violations('x', { anyOf: [{ type: 'number' }, { const: 'unknown' }] })).toEqual(['value: matches none of 2 alternatives'])
    expect(violations('unknown', { anyOf: [{ type: 'number' }, { const: 'unknown' }] })).toEqual([])
    expect(violations(1, { allOf: [{ type: 'number' }, { enum: [2] }] })).toEqual(['value: expected one of 2'])
    const conditional: ContourSchema = { if: { const: 'a' }, then: { enum: ['a', 'b'] }, else: { const: 'z' } }
    expect(violations('a', conditional)).toEqual([])
    expect(violations('z', conditional)).toEqual([])
    expect(violations('q', conditional)).toEqual(['value: expected "z"'])
    expect(violations({ cause: 'x' }, { not: { required: ['cause'] } })).toEqual(['value: forbidden here'])
    expect(violations({}, { not: { required: ['cause'] } })).toEqual([])
  })

  it('resolves $ref to the root and to a $defs entry, and refuses any other', () => {
    const root: ContourSchema = { type: 'object', required: ['n'], properties: { n: { $ref: '#/$defs/count' } }, $defs: { count: { type: 'number' }, again: { allOf: [{ $ref: '#' }] } } }
    expect(violations({ n: 'x' }, root)).toEqual(['n: expected number'])
    expect(violations({ n: 1 }, { $ref: '#/$defs/again' }, '', root)).toEqual([])
    expect(violations({}, { $ref: '#/$defs/again' }, '', root)).toEqual(['n: missing'])
    expect(() => violations({}, { $ref: '#/$defs/missing' }, '', root)).toThrow('cannot resolve $ref #/$defs/missing')
    expect(() => violations({}, { $ref: 'other.json#' }, '', root)).toThrow('cannot resolve $ref other.json#')
  })

  it('refuses a type it does not read instead of passing it', () => {
    expect(() => violations(1, { type: 'float' })).toThrow('type float is not read')
  })
})
