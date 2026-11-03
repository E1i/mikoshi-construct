import { describe, expect, it, vi } from 'vitest'
import { DISK_FLOOR_BYTES, freeBytes, statfsReader } from '../../ports/disk.js'
import '../bus/launch-node.test.js'
import '../bus/launch-ladder-handoff.test.js'
import '../bus/launch-queue.test.js'
import '../bus/scopeflow.test.js'
import '../bus/window-requests.test.js'
import '../ghosts/preflight.test.js'

const GIB = 1024 ** 3

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>()
  const statfsSync = (() => ({ bavail: 1, bsize: 1024 ** 3 })) as unknown as typeof fs.statfsSync
  return { ...fs, default: { ...fs, statfsSync }, statfsSync }
})

describe('the launch suites under a runner with 1 GiB free', () => {
  it('read the stubbed disk, which is under the floor', () => {
    expect(freeBytes(statfsReader())).toBe(GIB)
    expect(GIB).toBeLessThan(DISK_FLOOR_BYTES)
  })
})
