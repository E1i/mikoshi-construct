import { describe, expect, it } from 'vitest'
import { OPERATOR_CONTEXT_THRESHOLD } from '../../shift/operator-boundary.js'

describe('the Operator boundary', () => {
  it('the Operator context threshold is 180000', () => {
    expect(OPERATOR_CONTEXT_THRESHOLD).toBe(180000)
  })
})
