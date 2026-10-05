import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const SCRIPT = path.resolve(import.meta.dirname, '..', 'scripts/construct/browser-lab.mjs')
const BROWSER_RUN_MS = 90_000
const BROWSER_LAB_RUNS = process.env.BROWSER_LAB === '1'

interface Manifest {
  [key: string]: unknown
  permissions?: string[]
  host_permissions?: string[]
  optional_permissions?: string[]
  optional_host_permissions?: string[]
}

interface Options {
  command: string
  positionals: string[]
  extension: string | undefined
  headed: boolean
  evaluate: string | undefined
  listenMs: number
  wait: string | undefined
}

interface BrowserLab {
  parseArguments: (argv: string[]) => Options
  grantOptional: (manifest: Manifest) => { manifest: Manifest, granted: string[] }
  extensionId: (manifest: Manifest, directory: string) => string
  UsageError: new () => Error
}

const { parseArguments, grantOptional, extensionId, UsageError } = await import(pathToFileURL(SCRIPT).href) as BrowserLab

const FIXTURE_MANIFEST = {
  manifest_version: 3,
  name: 'Lab Fixture',
  version: '1.2.3',
  permissions: ['storage'],
  optional_permissions: ['topSites'],
  background: { service_worker: 'sw.js' },
  action: { default_popup: 'popup.html' },
  options_page: 'options.html',
  content_scripts: [{ matches: ['http://127.0.0.1/covered/*'], js: ['content.js'] }],
}

const FIXTURE_FILES = {
  'manifest.json': JSON.stringify(FIXTURE_MANIFEST),
  'sw.js': 'chrome.runtime.onInstalled.addListener(() => { chrome.storage.local.set({ seeded: \'yes\' }); console.log(\'lab installed\') })',
  'popup.html': '<title>Lab Popup</title><p>popup body</p>',
  'options.html': '<title>Lab Options</title><p>options body</p>',
  'content.js': 'document.documentElement.dataset.lab = \'on\'',
}

describe('arguments', () => {
  it('takes the command, its positional and the flags', () => {
    expect(parseArguments(['sw-eval', '1 + 1', '--extension', 'ext', '--headed'])).toMatchObject({ command: 'sw-eval', positionals: ['1 + 1'], extension: 'ext', headed: true })
  })

  it('is headless by default', () => {
    expect(parseArguments(['info', '--extension', 'ext']).headed).toBe(false)
  })

  it.each([
    [[]],
    [['launch']],
    [['info']],
    [['sw-eval', '--extension', 'ext']],
    [['storage', 'disk', '--extension', 'ext']],
    [['logs', '--for', '0', '--extension', 'ext']],
    [['page', 'http://x', '--wait']],
    [['info', '--extension', 'ext', '--verbose']],
  ])('refuses %j', (argv) => {
    expect(() => parseArguments(argv)).toThrow(UsageError)
  })

  it('lets page run without an extension', () => {
    expect(parseArguments(['page', 'http://x']).extension).toBeUndefined()
  })
})

describe('the lab copy of the manifest', () => {
  it('moves optional permissions and hosts into the granted ones', () => {
    const lab = grantOptional({ permissions: ['storage'], optional_permissions: ['topSites', 'storage'], host_permissions: ['https://a/*'], optional_host_permissions: ['https://b/*'] })
    expect(lab.manifest).toEqual({ permissions: ['storage', 'topSites'], host_permissions: ['https://a/*', 'https://b/*'] })
    expect(lab.granted).toEqual(['topSites', 'storage', 'https://b/*'])
  })

  it('leaves a manifest without optional permissions as it is', () => {
    expect(grantOptional({ name: 'x', permissions: ['storage'] })).toEqual({ manifest: { name: 'x', permissions: ['storage'] }, granted: [] })
  })
})

describe('the unpacked extension id', () => {
  it('is the first 32 hex digits of the path digest written in a to p', () => {
    expect(extensionId({}, '/tmp/ext')).toMatch(/^[a-p]{32}$/)
    expect(extensionId({}, '/tmp/ext')).not.toBe(extensionId({}, '/tmp/other'))
  })

  it('comes from the key when the manifest carries one', () => {
    expect(extensionId({ key: 'AAAA' }, '/tmp/ext')).toBe(extensionId({ key: 'AAAA' }, '/tmp/other'))
  })
})

interface LabRun {
  status: number | null
  json: Record<string, unknown>
  stderr: string
}

describe.runIf(BROWSER_LAB_RUNS)('the browser lab against an unpacked extension', { concurrent: true }, () => {
  let workspace: string
  let extension: string
  let server: Server
  let origin: string

  beforeAll(async () => {
    workspace = mkdtempSync(path.join(tmpdir(), 'browser-lab-test-'))
    extension = path.join(workspace, 'extension')
    mkdirSync(extension)
    for (const [name, body] of Object.entries(FIXTURE_FILES))
      writeFileSync(path.join(extension, name), body)
    server = createServer((_request, response) => {
      response.setHeader('content-type', 'text/html')
      response.end('<title>Served</title><p>served body</p>')
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(async () => {
    await new Promise(resolve => server.close(resolve))
    rmSync(workspace, { recursive: true, force: true })
  })

  async function lab(...argv: string[]): Promise<LabRun> {
    const child = spawn(process.execPath, [SCRIPT, ...argv, '--extension', extension], { timeout: BROWSER_RUN_MS - 5000 })
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
    })
    const status = await new Promise<number | null>(resolve => child.once('close', resolve))
    return { status, json: stdout.trim() === '' ? {} : JSON.parse(stdout) as Record<string, unknown>, stderr }
  }

  it('loads an unpacked extension headless', async () => {
    const run = await lab('info')
    expect(run.stderr).toBe('')
    expect(run.status).toBe(0)
    expect(run.json).toMatchObject({ name: 'Lab Fixture', version: '1.2.3', manifestVersion: 3, granted: ['topSites'] })
    expect(run.json.serviceWorker).toBe(`chrome-extension://${run.json.id as string}/sw.js`)
  }, BROWSER_RUN_MS)

  it('evaluates in the service worker', async () => {
    const run = await lab('sw-eval', 'chrome.runtime.getManifest().name + " " + chrome.runtime.id')
    expect(run.status).toBe(0)
    expect(run.json.result).toBe(`Lab Fixture ${run.json.id as string}`)
  }, BROWSER_RUN_MS)

  it('optional permissions need no prompt', async () => {
    const run = await lab('sw-eval', 'chrome.permissions.contains({ permissions: [\'topSites\'] }).then(async held => ({ held, sites: Array.isArray(await chrome.topSites.get()) }))')
    expect(run.status).toBe(0)
    expect(run.json.result).toEqual({ held: true, sites: true })
  }, BROWSER_RUN_MS)

  it('reads extension storage', async () => {
    const run = await lab('storage', 'local')
    expect(run.json).toMatchObject({ area: 'local', items: { seeded: 'yes' } })
  }, BROWSER_RUN_MS)

  it('collects the service worker console and uncaught errors', async () => {
    const run = await lab('logs', '--for', '3000', '--eval', 'console.log(\'lab says\', 2); setTimeout(() => { throw new Error(\'lab boom\') })')
    expect(run.status).toBe(0)
    expect(run.json.console).toContainEqual({ level: 'log', text: 'lab says 2' })
    expect(run.json.errors).toContainEqual('Error: lab boom')
  }, BROWSER_RUN_MS)

  it.for<[string, string, string]>([
    ['popup', 'Lab Popup', 'popup body'],
    ['options', 'Lab Options', 'options body'],
  ])('opens the %s page the manifest declares', { timeout: BROWSER_RUN_MS }, async ([command, title, text]) => {
    const run = await lab(command)
    expect(run.json).toMatchObject({ status: 200, title, text, errors: [] })
  })

  it('sees the content script on a page it matches', async () => {
    const run = await lab('page', `${origin}/covered/`, '--wait', 'html[data-lab="on"]')
    expect(run.status).toBe(0)
    expect(run.json).toMatchObject({ title: 'Served', contentScripts: ['Lab Fixture'], injected: true })
  }, BROWSER_RUN_MS)

  it('exits 1 on a page no content script matches', async () => {
    const run = await lab('page', `${origin}/elsewhere/`)
    expect(run.status).toBe(1)
    expect(run.json).toMatchObject({ title: 'Served', contentScripts: [], injected: false })
  }, BROWSER_RUN_MS)

  it('leaves the extension directory it was given untouched', () => {
    expect(JSON.parse(readFileSync(path.join(extension, 'manifest.json'), 'utf8'))).toEqual(FIXTURE_MANIFEST)
  })
})
