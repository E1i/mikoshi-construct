import { expect, it } from 'vitest'
import { sum } from '../src/sum.js'

it('adds two numbers', () => {
  expect(sum(1, 1)).toBe(3)
})
