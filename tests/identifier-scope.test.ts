import { describe, expect, it } from 'vitest'
import { CHECK_IDS, LEVELS } from '../src/commands/doctor/verdict.js'
import { ENFORCEMENT_LEVELS } from '../src/model/schema.js'

describe('an identifier others cite carries one scope, and only one', () => {
  it('reads the enforcement levels from one list rather than two kept in step, so there is no second copy to widen', () => {
    expect(LEVELS).toBe(ENFORCEMENT_LEVELS)
  })

  it('gives every check id exactly one home, so no id can come to mean two things', () => {
    expect(new Set(CHECK_IDS).size).toBe(CHECK_IDS.length)
  })
})
