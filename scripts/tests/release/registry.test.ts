import type { ReleaseRoute, ReleaseRouteReading } from '../../release/changesets.js'
import type { RegistryFetchers } from '../../release/registry.js'
import { describe, expect, it, vi } from 'vitest'
import { checkVersion, describeOutcome, EXIT_CODE, pollForVersion } from '../../release/registry.js'

const REQUEST = { packageName: 'mikoshi-construct', version: '0.3.0' }

const TARBALL = 'https://registry.npmjs.org/mikoshi-construct/-/mikoshi-construct-0.3.0.tgz'

function served(version: string): Response {
  return new Response(JSON.stringify({ version, dist: { tarball: TARBALL } }), { status: 200, headers: { 'content-type': 'application/json' } })
}

function failing(status: number): Response {
  return new Response('', { status })
}

function ok(): Response {
  return new Response('', { status: 200 })
}

function registry(metadata: () => Promise<Response>, tarball: () => Promise<Response> = async () => ok()): RegistryFetchers & { tarballUrls: string[] } {
  const tarballUrls: string[] = []
  return {
    tarballUrls,
    metadata: async () => metadata(),
    tarball: async (url) => {
      tarballUrls.push(url)
      return tarball()
    },
  }
}

interface FakeClock {
  now: () => number
  sleep: (milliseconds: number) => Promise<void>
  slept: number[]
}

function fakeClock(): FakeClock {
  let time = 0
  const slept: number[] = []
  return {
    slept,
    now: () => time,
    sleep: async (milliseconds) => {
      slept.push(milliseconds)
      time += milliseconds
    },
  }
}

const THREE_MINUTES = 180_000
const FIFTEEN_SECONDS = 15_000

describe('registry query', () => {
  it('reads served metadata and a tarball answering 200 as installable, and asks for the tarball the metadata names', async () => {
    const fetchers = registry(async () => served('0.3.0'))
    await expect(checkVersion(REQUEST, fetchers)).resolves.toBe('installable')
    expect(fetchers.tarballUrls).toEqual([TARBALL])
  })

  it('reads served metadata with a tarball answering 404 as published but not yet on the CDN', async () => {
    await expect(checkVersion(REQUEST, registry(async () => served('0.3.0'), async () => failing(404)))).resolves.toBe('propagating')
  })

  it('reads a tarball request that throws or fails otherwise as unreachable, never as propagating', async () => {
    await expect(checkVersion(REQUEST, registry(async () => served('0.3.0'), async () => failing(503)))).resolves.toBe('unreachable')
    await expect(checkVersion(REQUEST, registry(async () => served('0.3.0'), async () => {
      throw new Error('ECONNRESET')
    }))).resolves.toBe('unreachable')
  })

  it('reads a 404 on the metadata as absent', async () => {
    await expect(checkVersion(REQUEST, registry(async () => failing(404)))).resolves.toBe('absent')
  })

  it('reads an answer without the version as absent', async () => {
    await expect(checkVersion(REQUEST, registry(async () => served('0.2.0')))).resolves.toBe('absent')
  })

  it('reads a thrown metadata request as unreachable, never as absent', async () => {
    await expect(checkVersion(REQUEST, registry(async () => {
      throw new Error('ENOTFOUND registry.npmjs.org')
    }))).resolves.toBe('unreachable')
  })

  it('reads a non-404 metadata failure status as unreachable, never as absent', async () => {
    await expect(checkVersion(REQUEST, registry(async () => failing(503)))).resolves.toBe('unreachable')
  })
})

describe('registry poller', () => {
  it('turns green once the tarball appears: 404 on the first requests, then 200', async () => {
    const tarball = vi.fn()
      .mockResolvedValueOnce(failing(404))
      .mockResolvedValueOnce(failing(404))
      .mockResolvedValueOnce(failing(404))
      .mockResolvedValue(ok())
    const clock = fakeClock()

    const outcome = await pollForVersion(REQUEST, { fetchers: registry(async () => served('0.3.0'), tarball), ...clock, timeoutMs: THREE_MINUTES, delayMs: FIFTEEN_SECONDS })

    expect(outcome).toBe('installable')
    expect(tarball).toHaveBeenCalledTimes(4)
    expect(clock.slept).toEqual([FIFTEEN_SECONDS, FIFTEEN_SECONDS, FIFTEEN_SECONDS])
  })

  it('turns green once the metadata appears', async () => {
    const metadata = vi.fn()
      .mockResolvedValueOnce(failing(404))
      .mockResolvedValue(served('0.3.0'))
    const clock = fakeClock()

    const outcome = await pollForVersion(REQUEST, { fetchers: registry(metadata), ...clock, timeoutMs: THREE_MINUTES, delayMs: FIFTEEN_SECONDS })

    expect(outcome).toBe('installable')
    expect(metadata).toHaveBeenCalledTimes(2)
  })

  it('reports a tarball that never reaches the CDN as propagating after three minutes, without sleeping past the deadline', async () => {
    const clock = fakeClock()

    const outcome = await pollForVersion(REQUEST, { fetchers: registry(async () => served('0.3.0'), async () => failing(404)), ...clock, timeoutMs: THREE_MINUTES, delayMs: FIFTEEN_SECONDS })

    expect(outcome).toBe('propagating')
    expect(clock.now()).toBeLessThanOrEqual(THREE_MINUTES)
    expect(clock.slept.reduce((total, milliseconds) => total + milliseconds, 0)).toBe(THREE_MINUTES)
    expect(clock.slept.every(milliseconds => milliseconds === FIFTEEN_SECONDS)).toBe(true)
  })

  it('returns absent when the metadata never appears within the deadline', async () => {
    const clock = fakeClock()
    const outcome = await pollForVersion(REQUEST, { fetchers: registry(async () => failing(404)), ...clock, timeoutMs: THREE_MINUTES, delayMs: FIFTEEN_SECONDS })
    expect(outcome).toBe('absent')
  })

  it('keeps unreachable as the outcome when the registry could never be asked', async () => {
    const clock = fakeClock()
    const outcome = await pollForVersion(REQUEST, {
      fetchers: registry(async () => {
        throw new Error('timeout')
      }),
      ...clock,
      timeoutMs: 30_000,
      delayMs: FIFTEEN_SECONDS,
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
    expect(EXIT_CODE).toEqual({ installable: 0, absent: 1, unreachable: 2, propagating: 3 })
  })

  it('names a published version whose tarball has not reached the CDN as published, not as absent or failed', () => {
    for (const route of [VERSIONING, PUBLISHING, UNKNOWN]) {
      const message = describeOutcome('propagating', REQUEST, route)

      expect(message).toContain('mikoshi-construct@0.3.0 is published')
      expect(message).toContain('not reached the CDN yet')
      expect(message).not.toContain('not on the registry')
      expect(message).not.toContain('failed while reporting success')
    }
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
