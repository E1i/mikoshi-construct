import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach } from 'vitest'

export function useIsolatedHome(): () => string {
  let home = ''
  let previous: string | undefined
  beforeEach(() => {
    previous = process.env.HOME
    home = mkdtempSync(path.join(tmpdir(), 'construct-home-'))
    process.env.HOME = home
  })
  afterEach(() => {
    if (previous === undefined)
      delete process.env.HOME
    else
      process.env.HOME = previous
    rmSync(home, { recursive: true })
  })
  return () => home
}
