import { describe, expect, it } from 'vitest'
import { cloudOn } from '../../ghosts/cloud-key.js'
import { roleOutcome } from '../../ghosts/role.js'

describe('ghosts:role', () => {
  it('ghosts:role with CONSTRUCT_CLOUD unset launches the role locally, as today', () => {
    expect(roleOutcome(['review', '--task', 't1'], {})).toEqual({ code: 0, out: ['local: launch the review agent for t1'], err: [] })
    expect(roleOutcome(['scan', '--task', 't1'], { CONSTRUCT_CLOUD: 'off' }).out).toEqual(['local: launch the scan agent for t1'])
  })

  it('names the branch, the files and the acceptance when CONSTRUCT_CLOUD is 1', () => {
    const outcome = roleOutcome(['review', '--task', 't1'], { CONSTRUCT_CLOUD: '1' })
    expect(outcome.code).toBe(0)
    expect(outcome.out).toEqual(['cloud: review for t1 runs as a cloud session; it pushes role/t1-review with role/t1/review.md (and, for review, role/t1/review.verdict.json); accept with pnpm ghosts:verdict --from <ref> ...'])
  })

  it.each([
    { name: 'an unknown role', argv: ['plan', '--task', 't1'] },
    { name: 'a missing task', argv: ['brief'] },
  ])('prints usage on stderr and exits 1 for $name', ({ argv }) => {
    const outcome = roleOutcome(argv, {})
    expect(outcome.code).toBe(1)
    expect(outcome.out).toEqual([])
    expect(outcome.err[0]).toContain('usage: role.ts')
  })

  it('reads only the value 1 as cloud; 0, unset and anything else stay local', () => {
    expect([{ CONSTRUCT_CLOUD: '1' }, { CONSTRUCT_CLOUD: '0' }, { CONSTRUCT_CLOUD: 'on' }, {}].map(cloudOn)).toEqual([true, false, false, false])
  })
})
