import { vi } from 'vitest'

const GIB = 1024 ** 3

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>()
  const statfsSync = (() => ({ bavail: 1, bsize: GIB })) as unknown as typeof fs.statfsSync
  return { ...fs, default: { ...fs, statfsSync }, statfsSync }
})
