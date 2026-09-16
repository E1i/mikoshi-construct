import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'

it('the contract closes every response body', () => {
  expect(readFileSync('contracts/api/openapi.yaml', 'utf8')).toContain('additionalProperties: false')
})
