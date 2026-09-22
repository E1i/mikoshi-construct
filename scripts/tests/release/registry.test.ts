import type { ReleaseRoute, ReleaseRouteReading } from '../../release/changesets.js'
import { describe, expect, it, vi } from 'vitest'
import { checkVersion, describeOutcome, EXIT_CODE, pollForVersion } from '../../release/registry.js'

const REQUEST = { packageName: 'mikoshi-construct', version: '0.3.0' }

function served(version: string): Response {
  return new Response(JSON.stringify({ version }), { status: 200, headers: { 'content-type': 'application/json' } })
}

function failing(status: number): Response {
  return new Response('', { status })
}

describe('registry query', () => {
  it('reads a response carrying the version as installable', async () => {
    await expect(checkVersion(REQUEST, async () => served('0.3.0'))).resolves.toBe('installable')
  })

  it('reads a 404 as absent', async () => {
    await expect(checkVersion(REQUEST, async () => failing(404))).resolves.toBe('absent')
  })

  it('reads an answer without the version as absent', async () => {
    await expect(checkVersion(REQUEST, async () => served('0.2.0'))).resolves.toBe('absent')
  })

  it('reads a thrown request as unreachable, never as absent', async () => {
    await expect(checkVersion(REQUEST, async () => {
      throw new Error('ENOTFOUND registry.npmjs.org')
    })).resolves.toBe('unreachable')
  })

  it('reads a non-404 failure status as unreachable, never as absent', async () => {
    await expect(checkVersion(REQUEST, async () => failing(503))).resolves.toBe('unreachable')
  })
})

describe('registry poller', () => {
  it('stops at the first installable without exhausting the attempts', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(failing(404))
      .mockResolvedValueOnce(served('0.3.0'))
    const sleep = vi.fn(async () => {})

    const outcome = await pollForVersion(REQUEST, { fetcher, sleep, attempts: 5, delayMs: 10 })

    expect(outcome).toBe('installable')
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledTimes(1)
  })

  it('returns absent after the configured number of attempts and never sleeps after the final one', async () => {
    const fetcher = vi.fn(async () => failing(404))
    const sleep = vi.fn(async () => {})

    const outcome = await pollForVersion(REQUEST, { fetcher, sleep, attempts: 3, delayMs: 10 })

    expect(outcome).toBe('absent')
    expect(fetcher).toHaveBeenCalledTimes(3)
    expect(sleep).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledWith(10)
  })

  it('keeps unreachable as the outcome when the registry could never be asked', async () => {
    const outcome = await pollForVersion(REQUEST, {
      fetcher: async () => {
        throw new Error('timeout')
      },
      sleep: async () => {},
      attempts: 2,
      delayMs: 0,
    })

    expect(outcome).toBe('unreachable')
  })
})

describe('verification report', () => {
  function reading(route: ReleaseRoute, pending: string[] = []): ReleaseRouteReading {
    return { dir: '.changeset', route, pending }
  }

  const VERSIONING = reading('versioning', ['olive-pugs-repeat.md'])
  const PUBLISHING = reading('publishing')
  const UNKNOWN = reading('unknown')

  it('maps each outcome to its exit code', () => {
    expect(EXIT_CODE).toEqual({ installable: 0, absent: 1, unreachable: 2 })
  })

  it('names all three states that produce the same empty answer when the tree cannot say which', () => {
    const message = describeOutcome('absent', REQUEST, UNKNOWN)

    expect(message).toContain('mikoshi-construct@0.3.0')
    expect(message).toContain('staged')
    expect(message).toContain('failed while reporting success')
    expect(message).toContain('never ran')
  })

  it('prescribes no repair while the state is undetermined, because the three repairs differ', () => {
    for (const reading of [UNKNOWN, PUBLISHING]) {
      const message = describeOutcome('absent', REQUEST, reading)

      expect(message).not.toContain('npm stage approve')
      expect(message).not.toContain('Approve')
      expect(message).toContain('the Release run')
    }
  })

  it('states that the publish never ran, rather than offering it as one of three, when the tree carries a changeset', () => {
    const message = describeOutcome('absent', REQUEST, VERSIONING)

    expect(message).toContain('did not publish')
    expect(message).toContain('1 unconsumed changeset')
    expect(message).toContain('olive-pugs-repeat.md')
    expect(message).not.toContain('staged')
    expect(message).not.toContain('failed while reporting success')
  })

  it('says the work reaches the registry under the version that pull request writes, not under this one', () => {
    const message = describeOutcome('absent', REQUEST, VERSIONING)

    expect(message).toContain('version pull request')
    expect(message).not.toContain('publishes 0.3.0')
  })

  it('agrees the noun with what it counted, so the evidence does not read as written by a machine', () => {
    const two = describeOutcome('absent', REQUEST, reading('versioning', ['a.md', 'b.md']))

    expect(two).toContain('2 unconsumed changesets are')
    expect(describeOutcome('absent', REQUEST, VERSIONING)).toContain('1 unconsumed changeset is')
  })

  it('drops the state the tree excludes: a tree with nothing pending leaves two, not three', () => {
    const message = describeOutcome('absent', REQUEST, PUBLISHING)

    expect(message).toContain('staged')
    expect(message).toContain('failed while reporting success')
    expect(message).not.toContain('never ran')
  })

  it('claims nothing about the published state when the registry was unreachable', () => {
    expect(describeOutcome('unreachable', REQUEST, UNKNOWN)).toContain('Unknown is not absent')
  })
})
