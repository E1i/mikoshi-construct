import type { GhSpawned } from '../../ports/gh.js'
import { describe, expect, it } from 'vitest'
import { GhBudgetWindow, GhFailed, ghPort } from '../../ports/gh.js'
import { ghStatusPublisher, REVIEW_STATUS_CONTEXT } from '../../ports/github-status.js'

function recordingPort(spawned: GhSpawned): { port: ReturnType<typeof ghPort>, calls: { args: string[], cwd: string | undefined }[] } {
  const calls: { args: string[], cwd: string | undefined }[] = []
  const port = ghPort({
    attempts: 1,
    budget: new GhBudgetWindow({ calls: 10, windowMs: 1000 }, () => 0),
    pause: () => {},
    spawn: (_command, args, options) => {
      calls.push({ args, cwd: options.cwd })
      return spawned
    },
  })
  return { port, calls }
}

const STATUS = { commit: 'abc1234', state: 'success', context: REVIEW_STATUS_CONTEXT, description: 'review verdict pass for task 7' } as const

describe('the review status publisher posts one commit status through the gh port', () => {
  it('posts the state, context and description of the status to the commit in the repository it was given', () => {
    const { port, calls } = recordingPort({ status: 0, stdout: '{}', stderr: '' })
    ghStatusPublisher('/repo', port)(STATUS)
    expect(calls).toEqual([{
      args: ['api', '--method', 'POST', 'repos/{owner}/{repo}/statuses/abc1234', '-f', 'state=success', '-f', 'context=review', '-f', 'description=review verdict pass for task 7'],
      cwd: '/repo',
    }])
  })

  it('throws the gh failure when the post fails', () => {
    const { port } = recordingPort({ status: 1, stdout: '', stderr: 'HTTP 422: no commit' })
    expect(() => ghStatusPublisher('/repo', port)(STATUS)).toThrow(GhFailed)
  })
})
