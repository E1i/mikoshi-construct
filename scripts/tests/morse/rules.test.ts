import type { Prediction, RuleId } from '../../morse/rules.js'
import { describe, expect, it } from 'vitest'
import { RULES } from '../../morse/rules.js'

describe('morse rule ids', () => {
  it('a rule id outside RULES does not compile', () => {
    // @ts-expect-error a rule id is one of the ids RULES lists
    const typo: RuleId = 'docs_only'
    // @ts-expect-error a prediction names a rule RULES lists
    const prediction: Prediction = { verdict: 'cheap', rule: 'docs_only', why: [] }
    expect(RULES.map(rule => rule.id)).not.toContain(typo)
    expect(prediction.rule).toBe(typo)
  })
})
