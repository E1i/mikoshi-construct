import { Buffer } from 'node:buffer'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const PLAYWRIGHT_CORE = 'playwright-core@1.62.1'
export const PLAYWRIGHT_CLI = '@playwright/cli@0.1.17'
const PUBLIC_REGISTRY = 'https://registry.npmjs.org/'
const NPX_CACHE = path.join(os.homedir(), '.construct', 'browser-lab', 'npm-cache')
const PROFILE_RUNTIME_FILES = new Set(['SingletonLock', 'SingletonSocket', 'SingletonCookie', 'DevToolsActivePort'])
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
const COMMANDS = ['info', 'sw-eval', 'storage', 'logs', 'network', 'popup', 'options', 'page', 'hands']
const POSITIONALS_OF = { 'info': [0, 0], 'sw-eval': [1, 1], 'storage': [0, 1], 'logs': [0, 0], 'network': [0, 0], 'popup': [0, 0], 'options': [0, 0], 'page': [1, 1], 'hands': [1, Number.POSITIVE_INFINITY] }
const CONSOLE_LOG = /^console-.*\.log$/
const CONSOLE_LOGS_BEFORE_OPEN = 'hands.console-before.json'
const HANDS_COPY_PREFIX = 'browser-lab-hands-'
const STALE_HANDS_COPY_MS = 6 * 60 * 60 * 1000
const WITHOUT_EXTENSION = new Set(['page'])
const VALUES_OF = { '--extension': 1, '--headed': 0, '--eval': 1, '--for': 1, '--wait': 1, '--page': 1, '--profile': 1, '--route': 2, '--prefix': 1, '--shot': 1, '--profile-from': 1, '--evidence': 1 }

const USAGE = [
  'usage: browser-lab.mjs <command> [--extension <dir>] [--headed] [--profile <dir>]',
  '  info                      id, name and version of the extension, the browser version, the service worker',
  '  sw-eval <expression>      evaluate in the extension service worker and print the result',
  '  storage [area]            chrome.storage.<area> (local, sync, session, managed; default local)',
  '  logs [--eval <expr>] [--for <ms>]   service worker console and uncaught errors while listening',
  '  network [--page <url>] [--eval <expr>] [--for <ms>]   requests of the service worker (sent, answered, failed) while it opens the page in the same browser and listens',
  '  popup | options           open the page the manifest declares and print its title, text and errors',
  '  page <url> [--wait <sel>] open a page; with --extension, whether a content script of the extension ran in it',
  '        [--prefix <text>]   console of every level, from the page and from the content-script world, whose text starts with <text>',
  '        [--route <url-glob> <file>]   answer the page requests matching the glob with the file (repeatable; the service worker requests are not routed)',
  '        [--shot <file>]     screenshot of the page',
  '  hands <args…>             run @playwright/cli with the lab copy of the extension and the --profile <dir> given; its own arguments go after --; end with: hands … -- close',
  '        [--evidence <dir>]  hands runs with <dir> as its working directory; hands … -- close writes the console of the session since its open to <dir>/console.json, and nothing when close fails',
  '  --profile-from <dir>      run on a fresh copy of a base profile, deleted at the end, so runs can go in parallel; an extension whose manifest has no key gets another id in the copy',
  '                            a hands copy whose session never closed is swept by the next hands run once it has been idle for six hours',
  '  --profile <dir>         keep the browser profile in <dir> after the run, so a login done once with --headed and the extension storage survive into later runs',
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
  const options = { command, positionals: [], extension: undefined, headed: false, evaluate: undefined, listenMs: DEFAULT_LISTEN_MS, wait: undefined, page: undefined, profile: undefined, route: [], prefix: undefined, shot: undefined, profileFrom: undefined, evidence: undefined }
  let index = 0
  while (index < rest.length) {
    const argument = rest[index]
    if (argument === '--') {
      options.positionals.push(...rest.slice(index + 1))
      break
    }
    if (!argument.startsWith('--')) {
      options.positionals.push(argument)
      index += 1
      continue
    }
    if (!Object.hasOwn(VALUES_OF, argument))
      throw new UsageError(`unknown argument ${argument}`)
    const given = rest.slice(index + 1, index + 1 + VALUES_OF[argument])
    if (given.length < VALUES_OF[argument] || given.some(text => text.startsWith('--')))
      throw new UsageError(`${argument} needs ${VALUES_OF[argument] === 2 ? 'two values' : 'a value'}`)
    const [value, second] = given
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
      case '--profile-from':
        options.profileFrom = value
        break
      case '--evidence':
        options.evidence = value
        break
      case '--route':
        options.route.push({ pattern: value, file: second })
        break
      case '--prefix':
        options.prefix = value
        break
      case '--shot':
        options.shot = value
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
  if (command !== 'page' && (options.route.length > 0 || options.prefix !== undefined || options.shot !== undefined))
    throw new UsageError('--route, --prefix and --shot belong to page')
  if (options.profile !== undefined && options.profileFrom !== undefined)
    throw new UsageError('--profile and --profile-from exclude each other')
  if (command === 'hands' && options.profile === undefined && options.profileFrom === undefined)
    throw new UsageError('hands needs --profile <dir> or --profile-from <dir>, the session it opens lives in it')
  if (command !== 'hands' && options.evidence !== undefined)
    throw new UsageError('--evidence belongs to hands')
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

export function npxEnvironment(base = process.env) {
  return { ...base, npm_config_registry: PUBLIC_REGISTRY, npm_config_cache: NPX_CACHE }
}

function runNpx(args, options) {
  return spawnSync('npx', args, { ...options, env: npxEnvironment() })
}

function npxBinary(spec, name) {
  const found = runNpx(['--yes', '--package', spec, '-c', `command -v ${name}`], { encoding: 'utf8' })
  const binary = (found.stdout ?? '').trim().split('\n').at(-1)
  if (found.status !== 0 || binary === '' || binary === undefined) {
    const stderrTail = (found.stderr ?? '').trim().split('\n').slice(-5).join(' | ')
    throw new Unobserved(`npx could not provide ${spec}${found.error === undefined ? '' : ` (${found.error.message})`}${stderrTail === '' ? '' : `: ${stderrTail}`}`)
  }
  return binary
}

async function loadChromium() {
  const binary = npxBinary(PLAYWRIGHT_CORE, 'playwright-core')
  const library = await import(pathToFileURL(path.join(path.dirname(realpathSync(binary)), 'index.mjs')))
  return library.chromium
}

function installChromium() {
  runNpx(['--yes', PLAYWRIGHT_CORE, 'install', 'chromium'], { stdio: ['ignore', 2, 2] })
}

export function handsConfig(extensionDirectory, profile, headed) {
  return {
    browser: {
      browserName: 'chromium',
      userDataDir: profile,
      launchOptions: {
        channel: 'chromium',
        headless: !headed,
        args: [`--disable-extensions-except=${extensionDirectory}`, `--load-extension=${extensionDirectory}`],
      },
    },
  }
}

function lastLines(text) {
  return text.trim().split('\n').slice(-5).join(' | ')
}

export function handsRefusal(ran) {
  if (ran.error !== undefined)
    return `hands failed: ${firstLine(ran.error)}`
  return `hands failed: exit ${ran.status}; stdout: ${lastLines(ran.stdout ?? '')}; stderr: ${lastLines(ran.stderr ?? '')}`
}

function handsCommandAndSession(positionals) {
  let command
  let session = 'default'
  for (let index = 0; index < positionals.length; index += 1) {
    const argument = positionals[index]
    if (argument === '-s') {
      session = positionals[index + 1] ?? session
      index += 1
    }
    else if (argument.startsWith('-s=')) {
      session = argument.slice(3)
    }
    else if (command === undefined && !argument.startsWith('-')) {
      command = argument
    }
  }
  return { command, session }
}

export function handsArguments(config, positionals) {
  return handsCommandAndSession(positionals).command === 'open' ? ['--config', config, ...positionals] : positionals
}

function handsCopyRoot() {
  return realpathSync(os.tmpdir())
}

function handsProfile(options) {
  const { session } = handsCommandAndSession(options.positionals)
  const key = createHash('sha256').update(`${path.resolve(options.evidence ?? '')}\n${session}`).digest('hex').slice(0, 16)
  return path.join(handsCopyRoot(), `${HANDS_COPY_PREFIX}${key}`)
}

function lastTouched(copy) {
  const config = path.join(copy, 'hands.config.json')
  return statSync(existsSync(config) ? config : copy, { throwIfNoEntry: false })?.mtimeMs
}

function sweepStaleHandsCopies(root, now = Date.now()) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(HANDS_COPY_PREFIX))
      continue
    const copy = path.join(root, entry.name)
    const touched = lastTouched(copy)
    if (touched !== undefined && now - touched > STALE_HANDS_COPY_MS)
      rmSync(copy, { recursive: true, force: true })
  }
}

function consoleLogs(evidence) {
  const directory = path.join(evidence, '.playwright-cli')
  return existsSync(directory) ? readdirSync(directory).filter(name => CONSOLE_LOG.test(name)).sort() : []
}

function rememberConsoleLogsBeforeOpen(evidence, profile) {
  const marker = path.join(profile, CONSOLE_LOGS_BEFORE_OPEN)
  if (!existsSync(marker))
    writeFileSync(marker, `${JSON.stringify(consoleLogs(evidence))}\n`)
}

function takeConsoleLogsBeforeOpen(profile) {
  const marker = path.join(profile, CONSOLE_LOGS_BEFORE_OPEN)
  if (!existsSync(marker))
    return []
  const before = JSON.parse(readFileSync(marker, 'utf8'))
  rmSync(marker, { force: true })
  return before
}

function writeConsole(evidence, session, before) {
  const directory = path.join(evidence, '.playwright-cli')
  const logs = consoleLogs(evidence).filter(name => !before.includes(name))
  const lines = logs.flatMap(name => readFileSync(path.join(directory, name), 'utf8').split('\n').filter(line => line.trim() !== ''))
  writeFileSync(path.join(evidence, 'console.json'), `${JSON.stringify({ session, console: lines }, null, 2)}\n`)
}

function runHands({ extension, options, profile }) {
  const binary = npxBinary(PLAYWRIGHT_CLI, 'playwright-cli')
  const config = path.join(profile, 'hands.config.json')
  writeFileSync(config, `${JSON.stringify(handsConfig(extension.directory, profile, options.headed), null, 2)}\n`)
  spawnSync(binary, ['install-browser', 'chromium'], { stdio: ['ignore', 2, 2], env: npxEnvironment() })
  const evidence = options.evidence === undefined ? undefined : path.resolve(options.evidence)
  const { command, session } = handsCommandAndSession(options.positionals)
  if (evidence !== undefined) {
    mkdirSync(evidence, { recursive: true })
    if (command === 'open')
      rememberConsoleLogsBeforeOpen(evidence, profile)
  }
  const ran = spawnSync(binary, handsArguments(config, options.positionals), { cwd: evidence, encoding: 'utf8', env: npxEnvironment() })
  const before = command === 'close' ? takeConsoleLogsBeforeOpen(profile) : []
  if (ran.error !== undefined || ran.status !== 0)
    throw new Unobserved(handsRefusal(ran))
  if (evidence !== undefined && command === 'close')
    writeConsole(evidence, session, before)
  return { id: extension.id, args: options.positionals, output: ran.stdout.trim() }
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

function consoleWorld(worlds, id) {
  const world = worlds.find(found => found.id === id)
  return world?.origin.startsWith('chrome-extension://') ? 'content-script' : 'page'
}

async function visit(context, url, wait, shot) {
  const page = await context.newPage()
  const messages = []
  const errors = []
  page.on('pageerror', error => errors.push(firstLine(error)))
  page.on('console', (message) => {
    if (message.type() === 'error')
      errors.push(message.text())
  })
  const worlds = []
  const session = await context.newCDPSession(page)
  session.on('Runtime.executionContextCreated', ({ context: created }) => worlds.push(created))
  session.on('Runtime.consoleAPICalled', (params) => {
    messages.push({ ...consoleLine({ params }), world: consoleWorld(worlds, params.executionContextId) })
  })
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
  if (shot !== undefined)
    await page.screenshot({ path: shot })
  const title = await page.title()
  const text = (await page.evaluate(() => document.body?.textContent?.trim() ?? '')).slice(0, PAGE_TEXT_LIMIT)
  return { status: response?.status() ?? null, title, text, errors, worlds, messages }
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
    const { worlds, messages, ...seen } = await visit(context, url, options.wait)
    return { id: extension.id, url, ...seen }
  },
  'page': async function ({ context, extension, options }) {
    const [url] = options.positionals
    for (const { pattern, file } of options.route) {
      const body = path.resolve(file)
      if (!existsSync(body))
        throw new Unobserved(`the route file ${body} does not exist`)
      await context.route(pattern, route => route.fulfill({ path: body }))
    }
    const { worlds, messages, ...seen } = await visit(context, url, options.wait, options.shot === undefined ? undefined : path.resolve(options.shot))
    const heard = messages.filter(message => message.text.startsWith(options.prefix ?? ''))
    seen.console = heard
    if (options.shot !== undefined)
      seen.shot = path.resolve(options.shot)
    if (extension === undefined)
      return { url, ...seen }
    const origin = `chrome-extension://${extension.id}`
    const contentScripts = [...new Set(worlds.filter(world => world.origin === origin).map(world => world.name))]
    return { id: extension.id, url, ...seen, contentScripts, injected: contentScripts.length > 0 }
  },
}
RUNS.options = RUNS.popup
RUNS.hands = runHands

function copyProfile(base, profile) {
  if (!existsSync(base))
    throw new Unobserved(`the base profile ${base} does not exist`)
  cpSync(base, profile, { recursive: true, filter: source => !PROFILE_RUNTIME_FILES.has(path.basename(source)) })
}

export async function run(options) {
  const sessionCopy = options.command === 'hands' && options.profileFrom !== undefined
  if (sessionCopy)
    sweepStaleHandsCopies(handsCopyRoot())
  const keptProfile = sessionCopy ? handsProfile(options) : options.profile
  const kept = keptProfile !== undefined
  if (kept)
    mkdirSync(keptProfile, { recursive: true })
  const workspace = kept ? undefined : realpathSync(mkdtempSync(path.join(os.tmpdir(), 'browser-lab-')))
  const profile = kept ? realpathSync(keptProfile) : path.join(workspace, 'profile')
  let context
  try {
    if (options.profileFrom !== undefined && !(sessionCopy && existsSync(path.join(profile, 'hands.config.json'))))
      copyProfile(path.resolve(options.profileFrom), profile)
    const extension = options.extension === undefined ? undefined : prepareExtension(path.resolve(options.extension), path.join(kept ? profile : workspace, 'extension'))
    context = options.command === 'hands' ? undefined : await launch(options, profile, extension)
    const result = await RUNS[options.command]({ context, extension, options, profile })
    return { code: result.injected === false ? EXIT_FALSE : EXIT_HOLDS, result }
  }
  finally {
    await context?.close().catch(() => {})
    if (!kept)
      rmSync(workspace, { recursive: true, force: true })
    if (sessionCopy && handsCommandAndSession(options.positionals).command === 'close')
      rmSync(profile, { recursive: true, force: true })
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
