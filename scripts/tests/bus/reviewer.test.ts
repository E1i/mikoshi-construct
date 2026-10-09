import { describe, expect, it } from 'vitest'
import { reviewOf, reviewPrompt, reviewSession } from '../../bus/reviewer.js'
import { sessionArgv } from '../../ghosts/session.js'
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

  it('the prompt names the task, the pull request, its tree, its head and the verdict file', () => {
    const prompt = reviewPrompt(lease, '/tmp/t', '/tmp/v.json')
    expect(prompt.split('\n')[0]).toBe(`[review:${lease.taskKey}]`)
    expect(prompt).toContain(`Pull request #950 of card #1050 is checked out at /tmp/t, at its head ${sha('a')}`)
    expect(prompt).toContain('writing /tmp/v.json as JSON')
  })

  it('the review session starts in the worker repository, never in the tree of the pull request it reviews', () => {
    const params = reviewSession('/repo', '/reviews', 's-1', lease)
    expect(params.cwd).toBe('/repo')
    expect(params.tree).toBe('/reviews/s-1')
    expect(params.cwd).not.toBe(params.tree)
    expect(params.addDirs).toEqual(['/reviews'])
    expect(params.prompt).toContain('checked out at /reviews/s-1')
  })

  it('an added directory goes before the headless flags, so it cannot take the prompt as a second directory', () => {
    const argv = sessionArgv('s-1', 'the prompt', ['/reviews'])
    expect(argv.slice(0, 3)).toEqual(['--add-dir', '/reviews', '-p'])
    expect(argv.at(-1)).toBe('the prompt')
    expect(sessionArgv('s-1', 'the prompt')[0]).toBe('-p')
  })
})
