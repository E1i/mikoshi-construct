import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const SCRIPT = path.join(REPO_ROOT, 'scripts/construct/daemon.mjs')
const FIXTURE = path.join(import.meta.dirname, 'fixtures/daemon-adapter')
const ADAPTER_DIRECTORY = '.construct/daemon/sample'
const FIELDS = ['extension', 'prepare', 'objects', 'mechanic', 'success']
const TWINS = ['scripts/construct/daemon.mjs', 'scripts/construct/daemon-adapter.schema.json']

let workspace: string

function adapterPath(): string {
  return path.join(workspace, ADAPTER_DIRECTORY, 'adapter.json')
}

function readAdapter(): Record<string, unknown> {
  return JSON.parse(readFileSync(adapterPath(), 'utf8')) as Record<string, unknown>
}

function writeAdapter(adapter: Record<string, unknown>): void {
  writeFileSync(adapterPath(), `${JSON.stringify(adapter, null, 2)}\n`)
}

function check(target = adapterPath()): { status: number | null, stdout: string } {
  const result = spawnSync(process.execPath, [SCRIPT, 'check', target], { encoding: 'utf8' })
  return { status: result.status, stdout: result.stdout }
}

beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), 'daemon-adapter-test-'))
  cpSync(path.join(FIXTURE, 'repo'), workspace, { recursive: true })
  mkdirSync(path.join(workspace, ADAPTER_DIRECTORY), { recursive: true })
  cpSync(path.join(FIXTURE, 'adapter'), path.join(workspace, ADAPTER_DIRECTORY), { recursive: true })
})

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true })
})

describe('daemon.mjs check', () => {
  it('accepts the fixture adapter', () => {
    const result = check()
    expect(result.stdout).toContain('adapter sample: holds to the contract')
    expect(result.status).toBe(0)
  })

  it('accepts the adapter by its directory', () => {
    expect(check(path.join(workspace, ADAPTER_DIRECTORY)).status).toBe(0)
  })

  for (const field of FIELDS) {
    it(`refuses an adapter missing ${field}, naming the field`, () => {
      const { [field]: _dropped, ...rest } = readAdapter()
      writeAdapter(rest)
      const result = check()
      expect(result.status).toBe(1)
      expect(result.stdout).toContain(`missing field: ${field}`)
    })
  }

  it('refuses a field beyond the five', () => {
    writeAdapter({ ...readAdapter(), browser: 'chromium' })
    const result = check()
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('unknown field: browser')
  })

  it('refuses an extension without its directory', () => {
    writeAdapter({ ...readAdapter(), extension: { build: 'node build.mjs' } })
    const result = check()
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('missing field: extension.directory')
  })

  it('refuses a mechanic prompt file that does not exist', () => {
    writeAdapter({ ...readAdapter(), mechanic: `${ADAPTER_DIRECTORY}/absent.md` })
    const result = check()
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('mechanic:')
  })

  it('refuses an adapter whose command script imports mikoshi-construct', () => {
    writeFileSync(path.join(workspace, ADAPTER_DIRECTORY, 'objects.mjs'), 'import { runInit } from \'mikoshi-construct\'\nrunInit()\n')
    const result = check()
    expect(result.status).toBe(1)
    expect(result.stdout).toContain(`imports mikoshi-construct: ${ADAPTER_DIRECTORY}/objects.mjs`)
  })

  it('refuses an adapter whose extension requires a mikoshi-construct subpath', () => {
    writeFileSync(path.join(workspace, 'extension', 'background.js'), 'const core = require(\'mikoshi-construct/dist/cli.js\')\n')
    const result = check()
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('imports mikoshi-construct: extension/background.js')
  })

  it('refuses an adapter whose build script imports mikoshi-construct dynamically', () => {
    writeFileSync(path.join(workspace, ADAPTER_DIRECTORY, 'build.mjs'), 'await import( \'mikoshi-construct\')\n')
    const result = check()
    expect(result.status).toBe(1)
    expect(result.stdout).toContain(`imports mikoshi-construct: ${ADAPTER_DIRECTORY}/build.mjs`)
  })

  it('refuses a file that is not .construct/daemon/<name>/adapter.json as a usage error', () => {
    expect(check(path.join(workspace, 'extension', 'manifest.json')).status).toBe(2)
  })
})

describe('the daemon template copies', () => {
  for (const file of TWINS) {
    it(`${file} is byte-identical to its template`, () => {
      expect(readFileSync(path.join(REPO_ROOT, file)).equals(readFileSync(path.join(REPO_ROOT, 'templates/ai/claude', file)))).toBe(true)
    })
  }
})
