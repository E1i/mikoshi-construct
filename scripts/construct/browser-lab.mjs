import { Buffer } from 'node:buffer'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PLAYWRIGHT_CORE = 'playwright-core@1.62.1'
const EXIT_HOLDS = 0
const EXIT_FALSE = 1
const EXIT_UNOBSERVED = 127
const SERVICE_WORKER_TIMEOUT_MS = 10_000
const DEFAULT_LISTEN_MS = 2000
const WAIT_TIMEOUT_MS = 10_000
const DEVTOOLS_PORT_POLL_MS = 50
const DEVTOOLS_PORT_TIMEOUT_MS = 5000
const PAGE_TEXT_LIMIT = 2000
const STORAGE_AREAS = ['local', 'sync', 'session', 'managed']
const COMMANDS = ['info', 'sw-eval', 'storage', 'logs', 'network', 'popup', 'options', 'page']
const POSITIONALS_OF = { 'info': [0, 0], 'sw-eval': [1, 1], 'storage': [0, 1], 'logs': [0, 0], 'network': [0, 0], 'popup': [0, 0], 'options': [0, 0], 'page': [1, 1] }
const WITHOUT_EXTENSION = new Set(['page'])
const VALUES_OF = { '--extension': 1, '--headed': 0, '--eval': 1, '--for': 1, '--wait': 1, '--page': 1, '--profile': 1 }

const USAGE = [
  'usage: browser-lab.mjs <command> [--extension <dir>] [--headed] [--profile <dir>]',
  '  info                      id, name and version of the extension, the browser version, the service worker',
  '  sw-eval <expression>      evaluate in the extension service worker and print the result',
  '  storage [area]            chrome.storage.<area> (local, sync, session, managed; default local)',
  '  logs [--eval <expr>] [--for <ms>]   service worker console and uncaught errors while listening',
  '  network [--page <url>] [--eval <expr>] [--for <ms>]   requests of the service worker (sent, answered, failed) while it opens the page in the same browser and listens',
  '  popup | options           open the page the manifest declares and print its title, text and errors',
  '  page <url> [--wait <sel>] open a page; with --extension, whether a content script of the extension ran in it',
  '  --profile <dir>           keep the browser profile in <dir> after the run, so a login done once with --headed and the extension storage survive into later runs',
  '  every command prints one JSON object; optional permissions are granted in a lab copy, so no prompt appears',
  '  exit: 0 observed, 1 page saw no content script of the extension, 127 could not observe or a usage error',
].join('\n')

export class UsageError extends Error {}
export class Unobserved extends Error {}

function firstLine(error) {
  return String(error?.message ?? error).split('\n')[0]
}

function positive(text, flag) {
  const number = Number(text)
  if (!(number > 0))
    throw new UsageError(`${flag} needs a positive number, got ${text}`)
  return number
}

export function parseArguments(argv) {
  const [command, ...rest] = argv
  if (!COMMANDS.includes(command))
    throw new UsageError(command === undefined ? 'a command is required' : `unknown command ${command}`)
  const options = { command, positionals: [], extension: undefined, headed: false, evaluate: undefined, listenMs: DEFAULT_LISTEN_MS, wait: undefined, page: undefined, profile: undefined }
  let index = 0
  while (index < rest.length) {
    const argument = rest[index]
    if (!argument.startsWith('--')) {
      options.positionals.push(argument)
      index += 1
      continue
    }
    if (!Object.hasOwn(VALUES_OF, argument))
      throw new UsageError(`unknown argument ${argument}`)
    const value = rest[index + 1]
    if (VALUES_OF[argument] === 1 && (value === undefined || value.startsWith('--')))
      throw new UsageError(`${argument} needs a value`)
    index += 1 + VALUES_OF[argument]
    switch (argument) {
      case '--extension':
        options.extension = value
        break
      case '--headed':
        options.headed = true
        break
      case '--eval':
        options.evaluate = value
        break
      case '--for':
        options.listenMs = positive(value, argument)
        break
      case '--page':
        options.page = value
        break
      case '--profile':
        options.profile = value
        break
      default:
        options.wait = value
    }
  }
  const [least, most] = POSITIONALS_OF[command]
  if (options.positionals.length < least || options.positionals.length > most)
    throw new UsageError(`${command} takes ${least === most ? least : `${least} to ${most}`} argument${most === 1 ? '' : 's'}, got ${options.positionals.length}`)
  if (options.extension === undefined && !WITHOUT_EXTENSION.has(command))
    throw new UsageError(`${command} needs --extension <dir>`)
  if (command === 'storage' && options.positionals.length === 1 && !STORAGE_AREAS.includes(options.positionals[0]))
    throw new UsageError(`storage area must be one of ${STORAGE_AREAS.join(', ')}`)
  return options
}

export function grantOptional(manifest) {
  const granted = [...(manifest.optional_permissions ?? []), ...(manifest.optional_host_permissions ?? [])]
  const { optional_permissions: optionalPermissions = [], optional_host_permissions: optionalHosts = [], ...rest } = manifest
  const lab = { ...rest }
  if (optionalPermissions.length > 0)
    lab.permissions = [...new Set([...(manifest.permissions ?? []), ...optionalPermissions])]
  if (optionalHosts.length > 0)
    lab.host_permissions = [...new Set([...(manifest.host_permissions ?? []), ...optionalHosts])]
  return { manifest: lab, granted }
}

function letters(hex) {
  return [...hex.slice(0, 32)].map(digit => String.fromCharCode(97 + Number.parseInt(digit, 16))).join('')
}

export function extensionId(manifest, directory) {
  const source = manifest.key === undefined ? Buffer.from(directory) : Buffer.from(manifest.key, 'base64')
  return letters(createHash('sha256').update(source).digest('hex'))
}

function readManifest(directory) {
  try {
    return JSON.parse(readFileSync(path.join(directory, 'manifest.json'), 'utf8'))
  }
  catch (error) {
    throw new Unobserved(`${directory} has no readable manifest.json: ${firstLine(error)}`)
  }
}

function prepareExtension(source, directory) {
  const manifest = readManifest(source)
  rmSync(directory, { recursive: true, force: true })
  cpSync(source, directory, { recursive: true })
  const lab = grantOptional(manifest)
  writeFileSync(path.join(directory, 'manifest.json'), `${JSON.stringify(lab.manifest, null, 2)}\n`)
  return { directory, manifest: lab.manifest, granted: lab.granted, id: extensionId(lab.manifest, directory) }
}

async function loadChromium() {
  const found = spawnSync('npx', ['--yes', '--package', PLAYWRIGHT_CORE, '-c', 'command -v playwright-core'], { encoding: 'utf8' })
  const binary = (found.stdout ?? '').trim().split('\n').at(-1)
  if (found.status !== 0 || binary === '' || binary === undefined)
    throw new Unobserved(`npx could not provide ${PLAYWRIGHT_CORE}${found.error === undefined ? '' : ` (${found.error.message})`}`)
  const library = await import(pathToFileURL(path.join(path.dirname(realpathSync(binary)), 'index.mjs')))
  return library.chromium
}

function installChromium() {
  spawnSync('npx', ['--yes', PLAYWRIGHT_CORE, 'install', 'chromium'], { stdio: ['ignore', 2, 2] })
}

function sayOnStderr(line) {
  process.stderr.write(`${line}\n`)
}

export function ensureChromium(chromium, { exists = existsSync, install = installChromium, say = sayOnStderr } = {}) {
  if (exists(chromium.executablePath()))
    return
  say(`Chrome for Testing is missing for ${PLAYWRIGHT_CORE}; installing it with: npx ${PLAYWRIGHT_CORE} install chromium`)
  install()
}

async function launch(options, profile, extension) {
  const chromium = await loadChromium()
  ensureChromium(chromium)
  const loading = extension === undefined ? [] : [`--disable-extensions-except=${extension.directory}`, `--load-extension=${extension.directory}`]
  try {
    return await chromium.launchPersistentContext(profile, {
      channel: 'chromium',
      headless: !options.headed,
      args: [...loading, '--remote-debugging-port=0'],
    })
  }
  catch (error) {
    const missing = /Executable doesn't exist/.test(String(error.message))
    throw new Unobserved(missing
      ? `Chrome for Testing is not installed for ${PLAYWRIGHT_CORE}; install it with: npx ${PLAYWRIGHT_CORE} install chromium`
      : `Chrome for Testing could not be launched: ${firstLine(error)}`)
  }
}

async function startedWorker(context, extension) {
  const origin = `chrome-extension://${extension.id}/`
  const running = context.serviceWorkers().find(worker => worker.url().startsWith(origin))
  if (running !== undefined)
    return running
  if (extension.manifest.background?.service_worker === undefined)
    throw new Unobserved(`the extension ${extension.id} declares no background service worker`)
  try {
    return await context.waitForEvent('serviceworker', { predicate: worker => worker.url().startsWith(origin), timeout: SERVICE_WORKER_TIMEOUT_MS })
  }
  catch {
    throw new Unobserved(`the service worker of ${extension.id} did not start within ${SERVICE_WORKER_TIMEOUT_MS / 1000}s; run logs or info --headed to see why`)
  }
}

function untilActivated() {
  return globalThis.serviceWorker.state === 'activated' || new Promise(resolve => globalThis.serviceWorker.addEventListener('statechange', () => {
    if (globalThis.serviceWorker.state === 'activated')
      resolve(true)
  }))
}

async function serviceWorker(context, extension) {
  const worker = await startedWorker(context, extension)
  const activated = await Promise.race([worker.evaluate(untilActivated).catch(() => false), sleep(SERVICE_WORKER_TIMEOUT_MS).then(() => false)])
  if (!activated)
    throw new Unobserved(`the service worker of ${extension.id} did not activate within ${SERVICE_WORKER_TIMEOUT_MS / 1000}s; run logs or info --headed to see why`)
  return worker
}

async function evaluateIn(worker, expression) {
  try {
    return await worker.evaluate(expression)
  }
  catch (error) {
    throw new Unobserved(`evaluation failed in the service worker: ${firstLine(error)}`)
  }
}

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

async function devtoolsEndpoint(profile) {
  const deadline = Date.now() + DEVTOOLS_PORT_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      const [port, browserPath] = readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').trim().split('\n')
      return `ws://127.0.0.1:${port}${browserPath}`
    }
    catch {
      await sleep(DEVTOOLS_PORT_POLL_MS)
    }
  }
  throw new Unobserved('the browser did not publish its DevTools port')
}

async function openDevtools(url) {
  const socket = new WebSocket(url)
  await new Promise((resolve, reject) => {
    socket.onopen = resolve
    socket.onerror = () => reject(new Unobserved(`the DevTools endpoint ${url} refused the connection`))
  })
  const pending = new Map()
  const events = []
  let next = 0
  socket.onmessage = (message) => {
    const data = JSON.parse(message.data)
    if (data.id !== undefined && pending.has(data.id)) {
      pending.get(data.id)(data)
      pending.delete(data.id)
    }
    else {
      events.push(data)
    }
  }
  const send = (method, params = {}, sessionId = undefined) => new Promise((resolve) => {
    next += 1
    pending.set(next, resolve)
    socket.send(JSON.stringify({ id: next, method, params, sessionId }))
  })
  return { send, events, close: () => socket.close() }
}

function consoleLine(event) {
  return { level: event.params.type, text: event.params.args.map(arg => arg.value ?? arg.description ?? arg.type).join(' ') }
}

function errorLine(event) {
  const details = event.params.exceptionDetails
  return details.exception?.description?.split('\n')[0] ?? details.text
}

export function workerRequests(events) {
  const requests = new Map()
  for (const { method, params } of events) {
    if (method === 'Network.requestWillBeSent')
      requests.set(params.requestId, { url: params.request.url, method: params.request.method, status: null, failed: null })
    else if (method === 'Network.responseReceived' && requests.has(params.requestId))
      requests.get(params.requestId).status = params.response.status
    else if (method === 'Network.loadingFailed' && requests.has(params.requestId))
      requests.get(params.requestId).failed = params.errorText
  }
  return [...requests.values()]
}

async function listenToWorker(profile, extension, domain, during) {
  const devtools = await openDevtools(await devtoolsEndpoint(profile))
  try {
    const { result } = await devtools.send('Target.getTargets')
    const target = result.targetInfos.find(info => info.type === 'service_worker' && info.url.startsWith(`chrome-extension://${extension.id}/`))
    if (target === undefined)
      throw new Unobserved(`no service worker target for ${extension.id}`)
    const attached = await devtools.send('Target.attachToTarget', { targetId: target.targetId, flatten: true })
    const { sessionId } = attached.result
    await devtools.send(`${domain}.enable`, {}, sessionId)
    await during(expression => devtools.send('Runtime.evaluate', { expression, awaitPromise: true }, sessionId))
    return devtools.events.filter(event => event.sessionId === sessionId)
  }
  finally {
    devtools.close()
  }
}

async function listening(options, evaluate) {
  if (options.evaluate !== undefined)
    await evaluate(options.evaluate)
  await sleep(options.listenMs)
}

async function visit(context, url, wait) {
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(firstLine(error)))
  page.on('console', (message) => {
    if (message.type() === 'error')
      errors.push(message.text())
  })
  const worlds = []
  const session = await context.newCDPSession(page)
  session.on('Runtime.executionContextCreated', ({ context: created }) => worlds.push(created))
  await session.send('Runtime.enable')
  let response
  try {
    response = await page.goto(url, { waitUntil: 'load' })
    if (wait !== undefined)
      await page.waitForSelector(wait, { timeout: WAIT_TIMEOUT_MS })
  }
  catch (error) {
    throw new Unobserved(`${url} could not be observed: ${firstLine(error)}`)
  }
  const title = await page.title()
  const text = (await page.evaluate(() => document.body?.textContent?.trim() ?? '')).slice(0, PAGE_TEXT_LIMIT)
  return { status: response?.status() ?? null, title, text, errors, worlds }
}

function declaredPage(extension, command) {
  const declared = command === 'popup'
    ? extension.manifest.action?.default_popup
    : extension.manifest.options_ui?.page ?? extension.manifest.options_page
  if (declared === undefined)
    throw new Unobserved(`the manifest declares no ${command} page`)
  return `chrome-extension://${extension.id}/${declared.replace(/^\//, '')}`
}

const RUNS = {
  'info': async function ({ context, extension }) {
    const worker = extension.manifest.background?.service_worker === undefined ? undefined : await serviceWorker(context, extension)
    return {
      id: extension.id,
      name: extension.manifest.name,
      version: extension.manifest.version,
      manifestVersion: extension.manifest.manifest_version,
      browser: context.browser()?.version() ?? null,
      serviceWorker: worker?.url() ?? null,
      granted: extension.granted,
    }
  },
  'sw-eval': async function ({ context, extension, options }) {
    const worker = await serviceWorker(context, extension)
    return { id: extension.id, result: await evaluateIn(worker, options.positionals[0]) }
  },
  'storage': async function ({ context, extension, options }) {
    const area = options.positionals[0] ?? 'local'
    const worker = await serviceWorker(context, extension)
    return { id: extension.id, area, items: await evaluateIn(worker, `chrome.storage.${area}.get(null)`) }
  },
  'logs': async function ({ context, extension, options, profile }) {
    await serviceWorker(context, extension)
    const events = await listenToWorker(profile, extension, 'Runtime', evaluate => listening(options, evaluate))
    return {
      id: extension.id,
      console: events.filter(event => event.method === 'Runtime.consoleAPICalled').map(consoleLine),
      errors: events.filter(event => event.method === 'Runtime.exceptionThrown').map(errorLine),
    }
  },
  'network': async function ({ context, extension, options, profile }) {
    await serviceWorker(context, extension)
    let page
    const events = await listenToWorker(profile, extension, 'Network', async (evaluate) => {
      if (options.page !== undefined) {
        const { status, title } = await visit(context, options.page, options.wait)
        page = { url: options.page, status, title }
      }
      await listening(options, evaluate)
    })
    return { id: extension.id, ...(page === undefined ? {} : { page }), requests: workerRequests(events) }
  },
  'popup': async function ({ context, extension, options }) {
    const url = declaredPage(extension, options.command)
    const { worlds, ...seen } = await visit(context, url, options.wait)
    return { id: extension.id, url, ...seen }
  },
  'page': async function ({ context, extension, options }) {
    const [url] = options.positionals
    const { worlds, ...seen } = await visit(context, url, options.wait)
    if (extension === undefined)
      return { url, ...seen }
    const origin = `chrome-extension://${extension.id}`
    const contentScripts = [...new Set(worlds.filter(world => world.origin === origin).map(world => world.name))]
    return { id: extension.id, url, ...seen, contentScripts, injected: contentScripts.length > 0 }
  },
}
RUNS.options = RUNS.popup

export async function run(options) {
  const kept = options.profile !== undefined
  if (kept)
    mkdirSync(options.profile, { recursive: true })
  const workspace = kept ? undefined : realpathSync(mkdtempSync(path.join(os.tmpdir(), 'browser-lab-')))
  const profile = kept ? realpathSync(options.profile) : path.join(workspace, 'profile')
  let context
  try {
    const extension = options.extension === undefined ? undefined : prepareExtension(path.resolve(options.extension), path.join(kept ? profile : workspace, 'extension'))
    context = await launch(options, profile, extension)
    const result = await RUNS[options.command]({ context, extension, options, profile })
    return { code: result.injected === false ? EXIT_FALSE : EXIT_HOLDS, result }
  }
  finally {
    await context?.close().catch(() => {})
    if (!kept)
      rmSync(workspace, { recursive: true, force: true })
  }
}

function isEntry() {
  return process.argv[1] != null && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
}

async function main() {
  try {
    const outcome = await run(parseArguments(process.argv.slice(2)))
    process.stdout.write(`${JSON.stringify(outcome.result)}\n`)
    process.exit(outcome.code)
  }
  catch (error) {
    if (error instanceof UsageError)
      process.stderr.write(`usage error: ${error.message}\n${USAGE}\n`)
    else
      process.stderr.write(`could not observe: ${error instanceof Unobserved ? error.message : (error.stack ?? error)}\n`)
    process.exit(EXIT_UNOBSERVED)
  }
}

if (isEntry())
  await main()
