import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { cliEnv } from './cli-process.js'

describe('the characterization spawns the CLI with a temporary HOME but the machine\'s corepack cache', () => {
  it('keeps COREPACK_HOME outside the temporary HOME, so the pnpm probe is not downloaded again on every spawn', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'construct-home-'))
    const env = cliEnv(home)
    expect(env.HOME).toBe(home)
    expect(env.COREPACK_HOME).toBeTypeOf('string')
    expect(path.relative(home, env.COREPACK_HOME ?? home).startsWith('..')).toBe(true)
  })
})
