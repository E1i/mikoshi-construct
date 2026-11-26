import os from 'node:os'
import process from 'node:process'
import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.restoreAllMocks()
  vi.resetModules()
})

function passwdUnreadable(): never {
  throw Object.assign(new Error('A system error occurred: uv_os_get_passwd returned ENOENT (no such file or directory)'), { code: 'ERR_SYSTEM_ERROR', info: { code: 'ENOENT', syscall: 'uv_os_get_passwd' } })
}

describe('no module reads the password database at load', () => {
  it('importing shift-settings and card-grants calls no getpwuid', async () => {
    const lookup = vi.spyOn(os, 'userInfo').mockImplementation(passwdUnreadable)
    vi.resetModules()

    const grants = await import('../../ports/card-grants.js')
    const settings = await import('../../ports/shift-settings.js')
    const adapter = await import('../../ports/client/claude/adapter.js')

    expect(lookup).not.toHaveBeenCalled()
    const uid = String(process.getuid?.())
    expect(grants.GRANT_SCRATCH_DIRECTORY).toBe(`/tmp/claude-${uid}/codex-live-hooks`)
    expect(settings.TSX_PIPE_DIRECTORY).toBe(`/tmp/claude-${uid}/tsx-${uid}`)
    expect(adapter.CLIENT_SANDBOX_DIRECTORY).toBe(`/tmp/claude-${uid}`)
  })
})
