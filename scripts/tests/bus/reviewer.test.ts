import { describe, expect, it } from 'vitest'
import { reviewOf, reviewPrompt } from '../../bus/reviewer.js'
import { sha } from './github-fake.js'

const lease = { taskKey: `review:1050:950:${sha('a')}`, queue: 'review' as const, cardId: 1050, pr: 950, head: sha('a'), leaseGen: 1, actor: 'worker:review:w' }

describe('reviewer', () => {
  it('a review file gives the verdict, the findings and the session', () => {
    expect(reviewOf('{"verdict":"changes","findings":["x"]}', 's-1')).toEqual({ verdict: 'changes', findings: ['x'], session: 's-1' })
  })

  it('a review file without a verdict word or a findings list is refused', () => {
    expect(() => reviewOf('{"verdict":"approve","findings":[]}', 's-1')).toThrow(/names no verdict/)
    expect(() => reviewOf('{"verdict":"pass"}', 's-1')).toThrow(/no findings list/)
  })

  it('the prompt names the task, the pull request, its head and the verdict file', () => {
    const prompt = reviewPrompt(lease, '/tmp/v.json')
    expect(prompt.split('\n')[0]).toBe(`[review:${lease.taskKey}]`)
    expect(prompt).toContain(`pull request #950 of card #1050, checked out at its head ${sha('a')}`)
    expect(prompt).toContain('writing /tmp/v.json as JSON')
  })
})
