import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runInstall } from '../../ghosts/install.js'

function stubBinDir(script: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'ghosts-install-bin-'))
  const pnpm = path.join(dir, 'pnpm')
  writeFileSync(pnpm, `#!/usr/bin/env bash\n${script}\n`)
  chmodSync(pnpm, 0o755)
  return dir
}

describe('runInstall', () => {
  const originalPath = process.env.PATH

  beforeEach(() => {
    process.env.PATH = originalPath
  })

  afterEach(() => {
    process.env.PATH = originalPath
  })

  it('runs pnpm install --frozen-lockfile in cwd, writing stdout and stderr to the log', async () => {
    const bin = stubBinDir('echo out-line; echo err-line >&2; exit 0')
    process.env.PATH = `${bin}:${originalPath}`
    const work = mkdtempSync(path.join(tmpdir(), 'ghosts-install-work-'))
    const logPath = path.join(work, 'install.log')

    const code = await runInstall(work, logPath)

    expect(code).toBe(0)
    const log = readFileSync(logPath, 'utf8')
    expect(log).toContain('out-line')
    expect(log).toContain('err-line')
  })

  it('resolves the exit code the install process exits with', async () => {
    const bin = stubBinDir('exit 1')
    process.env.PATH = `${bin}:${originalPath}`
    const work = mkdtempSync(path.join(tmpdir(), 'ghosts-install-work-'))
    const logPath = path.join(work, 'install.log')

    const code = await runInstall(work, logPath)
    expect(code).toBe(1)
  })

  it('rejects when pnpm cannot be spawned', async () => {
    process.env.PATH = ''
    const work = mkdtempSync(path.join(tmpdir(), 'ghosts-install-work-'))
    const logPath = path.join(work, 'install.log')

    await expect(runInstall(work, logPath)).rejects.toThrow(/ENOENT/)
  })
})
