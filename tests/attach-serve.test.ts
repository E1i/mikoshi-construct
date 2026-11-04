import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ATTACH_RECORD_FILE, readAttachRecord, runAttach, runAttachUpgrade } from '../src/commands/attach/index.js'
import { ATTACH_SERVE_READY_TIMEOUT_MS } from '../src/commands/attach/record.js'
import { MANIFEST_FILE } from '../src/manifest.js'
import { getPreset } from '../src/presets/index.js'
import { createUi, silentWriter } from '../src/ui/console.js'
import { resolveTheme } from '../src/ui/theme.js'
import { useIsolatedHome } from './isolated-home.js'

const COMMAND = 'npm start'
const URL_OF_THE_SERVER = 'http://localhost:8080/'

const ui = createUi(resolveTheme({ plain: true }), silentWriter)
useIsolatedHome()

function repository(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'construct-attach-serve-'))
  writeFileSync(path.join(dir, 'server.js'), 'export {}\n')
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A'], { cwd: dir })
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'base'], { cwd: dir })
  return dir
}

describe('attach and the serve flags', () => {
  it('attach records --serve and --serve-url in attach.json', async () => {
    const dir = repository()
    const result = await runAttach(ui, { dir, yes: true, serve: COMMAND, serveUrl: URL_OF_THE_SERVER })
    expect(result.status).toBe('done')
    expect(readAttachRecord(dir)?.serve).toEqual({ command: COMMAND, url: URL_OF_THE_SERVER, readyTimeoutMs: ATTACH_SERVE_READY_TIMEOUT_MS })
    expect(existsSync(path.join(dir, MANIFEST_FILE))).toBe(false)
  })

  it('a serve from attach carries the same default timeout as a preset', () => {
    expect(ATTACH_SERVE_READY_TIMEOUT_MS).toBe(getPreset('node-backend').serve?.readyTimeoutMs)
  })

  it('attach without the flags records no serve', async () => {
    const dir = repository()
    await runAttach(ui, { dir, yes: true })
    expect(readAttachRecord(dir)).not.toBeNull()
    expect(readAttachRecord(dir)?.serve).toBeUndefined()
  })

  it('attach refuses --serve without --serve-url', async () => {
    const dir = repository()
    await expect(runAttach(ui, { dir, yes: true, serve: COMMAND })).rejects.toThrow('--serve was given without --serve-url')
    expect(existsSync(path.join(dir, ATTACH_RECORD_FILE))).toBe(false)
  })

  it('attach refuses --serve-url without --serve', async () => {
    const dir = repository()
    await expect(runAttach(ui, { dir, yes: true, serveUrl: URL_OF_THE_SERVER })).rejects.toThrow('--serve-url was given without --serve')
    expect(existsSync(path.join(dir, ATTACH_RECORD_FILE))).toBe(false)
  })

  it.each([
    ['an empty command', '  ', URL_OF_THE_SERVER],
    ['a URL that does not parse', COMMAND, 'not a url'],
    ['a URL that is not http', COMMAND, 'localhost:8080'],
  ])('attach refuses %s', async (_, serve, serveUrl) => {
    const dir = repository()
    await expect(runAttach(ui, { dir, yes: true, serve, serveUrl })).rejects.toThrow('nothing was written')
    expect(existsSync(path.join(dir, ATTACH_RECORD_FILE))).toBe(false)
  })

  it('--upgrade refuses both flags, because the record holds them', async () => {
    const dir = repository()
    await runAttach(ui, { dir, yes: true })
    expect(await runAttachUpgrade(ui, { dir, yes: true, serve: COMMAND })).toMatchObject({ status: 'refused', refusal: 'upgrade-flags' })
    expect(await runAttachUpgrade(ui, { dir, yes: true, serveUrl: URL_OF_THE_SERVER })).toMatchObject({ status: 'refused', refusal: 'upgrade-flags' })
  })
})
