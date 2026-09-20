import { describe, expect, it } from 'vitest'
import { CHECK_IDS, LEVELS } from '../src/commands/doctor/verdict.js'
import { ENFORCEMENT_LEVELS } from '../src/model/schema.js'

describe('an identifier others cite carries one scope, and only one', () => {
  it('spells the enforcement levels the same way in the model as in doctor, so widening one cannot leave the other behind', () => {
    expect([...ENFORCEMENT_LEVELS]).toEqual([...LEVELS])
  })

  it('gives every check id exactly one home, so no id can come to mean two things', () => {
    expect(new Set(CHECK_IDS).size).toBe(CHECK_IDS.length)
  })
})
