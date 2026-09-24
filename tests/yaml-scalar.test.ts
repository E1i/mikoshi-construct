import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { yamlScalar } from '../src/materialize/yaml-scalar.js'

const PLAIN = ['pnpm run quality', 'make check', 'npm run ci && npm test', 'bun run lint']

const NEEDS_QUOTING = [
  'make check: all # x',
  'true',
  'No',
  'null',
  '123',
  './scripts/check.sh',
  '- x',
  '"quoted"',
  'it\'s',
  'trailing ',
  ' leading',
  'a #b',
  'pnpm lint:fix',
  '*alias',
  '{ a }',
  'line\nbreak',
]

describe('a string rendered as a YAML scalar', () => {
  for (const value of [...PLAIN, ...NEEDS_QUOTING]) {
    it(`parses back to ${JSON.stringify(value)} verbatim`, () => {
      expect(parse(`run: ${yamlScalar(value)}\n`)).toEqual({ run: value })
    })
  }

  for (const value of PLAIN) {
    it(`leaves ${JSON.stringify(value)} bare`, () => {
      expect(yamlScalar(value)).toBe(value)
    })
  }
})
