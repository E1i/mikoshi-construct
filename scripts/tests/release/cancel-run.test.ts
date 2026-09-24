import { describe, expect, it } from 'vitest'
import { requestCancel, runIdentityFrom } from '../../release/cancel-run.js'

const RUN = { repository: 'E1i/mikoshi-construct', runId: '42', token: 'token-from-env' }

describe('a pending verification cancels its own run', () => {
  it('names its own run from the Actions environment', () => {
    expect(runIdentityFrom({ GITHUB_REPOSITORY: 'E1i/mikoshi-construct', GITHUB_RUN_ID: '42', GH_TOKEN: 'token-from-env' })).toEqual(RUN)
  })

  it('has no run to cancel outside Actions or without a token', () => {
    expect(runIdentityFrom({})).toBeUndefined()
    expect(runIdentityFrom({ GITHUB_REPOSITORY: 'E1i/mikoshi-construct', GITHUB_RUN_ID: '42' })).toBeUndefined()
  })

  it('asks for the cancellation of exactly its own run', async () => {
    const requests: Array<{ url: string, init: RequestInit }> = []

    const accepted = await requestCancel(RUN, async (url, init) => {
      requests.push({ url, init })
      return new Response('', { status: 202 })
    })

    expect(accepted).toBe(true)
    expect(requests).toHaveLength(1)
    expect(requests[0].url).toBe('https://api.github.com/repos/E1i/mikoshi-construct/actions/runs/42/cancel')
    expect(requests[0].init.method).toBe('POST')
  })

  it('reads a refused or failed request as not cancelled, so the run cannot end green', async () => {
    await expect(requestCancel(RUN, async () => new Response('', { status: 403 }))).resolves.toBe(false)
    await expect(requestCancel(RUN, async () => {
      throw new Error('ECONNRESET')
    })).resolves.toBe(false)
  })
})
