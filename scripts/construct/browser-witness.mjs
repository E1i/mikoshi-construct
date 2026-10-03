import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PLAYWRIGHT_CORE = 'playwright-core@1.62.1'
const EXIT_HOLDS = 0
const EXIT_FALSE = 1
const EXIT_UNOBSERVED = 127
const DEFAULT_WIDTHS = [375, 768, 1280]
const VIEWPORT_HEIGHT = 800
const SUBPIXEL_TOLERANCE = 0.01
const READY_TIMEOUT_SECONDS = 30
const READY_POLL_MS = 100
const STOP_GRACE_MS = 2000
const STDERR_TAIL = 400
const KEPT_RUNS = 5
const RUN_DIRECTORY = /^\d{8}T\d{9}Z-\d+$/
const DEFAULT_SHOTS = path.join('.construct', 'browser')
const VALUES_OF = {
  '--serve': 1,
  '--page': 1,
  '--at': 1,
  '--shots': 1,
  '--ready-timeout': 1,
  '--no-hscroll': 0,
  '--inside': 1,
  '--visible': 1,
  '--hidden': 1,
  '--no-overlap': 2,
  '--attr': 2,
}

const USAGE = [
  'usage: browser-witness.mjs --serve \'<command with {port}>\' --page <path> [--page <path>]... [--at <width>]...',
  '  assertions: --no-hscroll | --inside <sel> | --no-overlap <selA> <selB> | --attr <sel> <name>[=value] | --visible <sel> | --hidden <sel>',
  '  options: --shots <dir> (default .construct/browser) | --ready-timeout <seconds> (default 30)',
  '  exit: 0 every assertion holds, 1 one is false, 127 could not observe or a usage error',
].join('\n')

export class UsageError extends Error {}
export class Unobserved extends Error {}

export function exceedsViewport({ scrollWidth, innerWidth }) {
  return scrollWidth > innerWidth
}

export function insideInline(rect, innerWidth) {
  return rect.left >= -SUBPIXEL_TOLERANCE && rect.right <= innerWidth + SUBPIXEL_TOLERANCE
}

export function overlaps(a, b) {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
}

export function isVisible(element) {
  return element.width > 0 && element.height > 0 && element.display !== 'none' && element.visibility !== 'hidden'
}

function describeRect(rect) {
  return `[${rect.left},${rect.right}]x[${rect.top},${rect.bottom}]`
}

export function assertionLabel(assertion) {
  switch (assertion.kind) {
    case 'no-hscroll':
      return 'no-hscroll'
    case 'no-overlap':
      return `no-overlap ${assertion.selectors[0]} ${assertion.selectors[1]}`
    case 'attr':
      return `attr ${assertion.selectors[0]} ${assertion.name}${assertion.value === undefined ? '' : `=${assertion.value}`}`
    default:
      return `${assertion.kind} ${assertion.selectors[0]}`
  }
}

function everyElement(selector, elements, rule) {
  if (elements.length === 0)
    return { holds: false, detail: `${selector} matches 0 elements` }
  const wrong = elements.map((element, index) => ({ element, index })).filter(({ element }) => !rule.holds(element))
  if (wrong.length === 0)
    return { holds: true, detail: `${selector} ${elements.length} matched, ${rule.passed}` }
  return { holds: false, detail: wrong.map(({ element, index }) => `${selector}[${index}] ${rule.failed(element)}`).join(', ') }
}

function judgeNoOverlap(selectors, groups) {
  const empty = groups.findIndex(group => group.length === 0)
  if (empty !== -1)
    return { holds: false, detail: `${selectors[empty]} matches 0 elements` }
  const clashes = []
  groups[0].forEach((first, i) => groups[1].forEach((second, j) => {
    if (overlaps(first, second))
      clashes.push(`${selectors[0]}[${i}] ${describeRect(first)} overlaps ${selectors[1]}[${j}] ${describeRect(second)}`)
  }))
  return clashes.length === 0
    ? { holds: true, detail: `${selectors[0]} and ${selectors[1]} do not overlap` }
    : { holds: false, detail: clashes.join(', ') }
}

export function judge(assertion, observed) {
  const [selector] = assertion.selectors
  switch (assertion.kind) {
    case 'no-hscroll': {
      const { scrollWidth, innerWidth } = observed
      return exceedsViewport(observed)
        ? { holds: false, detail: `scrollWidth=${scrollWidth} > innerWidth=${innerWidth}` }
        : { holds: true, detail: `scrollWidth=${scrollWidth} <= innerWidth=${innerWidth}` }
    }
    case 'inside':
      return everyElement(selector, observed.groups[0], {
        holds: element => insideInline(element, observed.innerWidth),
        passed: `within 0..${observed.innerWidth}`,
        failed: element => `left=${element.left} right=${element.right} outside 0..${observed.innerWidth}`,
      })
    case 'no-overlap':
      return judgeNoOverlap(assertion.selectors, observed.groups)
    case 'attr':
      return everyElement(selector, observed.groups[0], {
        holds: element => element.attribute !== null && (assertion.value === undefined || element.attribute === assertion.value),
        passed: `${assertion.name} as asked`,
        failed: element => `${assertion.name}=${element.attribute === null ? 'absent' : JSON.stringify(element.attribute)}`,
      })
    case 'visible':
      return everyElement(selector, observed.groups[0], {
        holds: isVisible,
        passed: 'visible',
        failed: element => `not visible (${element.width}x${element.height}, display ${element.display}, visibility ${element.visibility})`,
      })
    default:
      return everyElement(selector, observed.groups[0], {
        holds: element => !isVisible(element),
        passed: 'hidden',
        failed: element => `visible (${element.width}x${element.height})`,
      })
  }
}

function takeValues(argv, index, flag) {
  const count = VALUES_OF[flag]
  const values = argv.slice(index + 1, index + 1 + count)
  if (values.length < count || values.some(value => value.startsWith('--')))
    throw new UsageError(`${flag} needs ${count} value${count === 1 ? '' : 's'}`)
  return values
}

function parseAttribute(spec) {
  const at = spec.indexOf('=')
  return at === -1 ? { name: spec, value: undefined } : { name: spec.slice(0, at), value: spec.slice(at + 1) }
}

function positive(text, flag) {
  const number = Number(text)
  if (!(number > 0))
    throw new UsageError(`${flag} needs a positive number, got ${text}`)
  return number
}

export function parseArguments(argv) {
  const options = { serve: undefined, pages: [], widths: [], assertions: [], shots: DEFAULT_SHOTS, readyTimeoutSeconds: READY_TIMEOUT_SECONDS }
  let index = 0
  while (index < argv.length) {
    const flag = argv[index]
    if (!Object.hasOwn(VALUES_OF, flag))
      throw new UsageError(`unknown argument ${flag}`)
    const values = takeValues(argv, index, flag)
    index += 1 + values.length
    switch (flag) {
      case '--serve':
        options.serve = values[0]
        break
      case '--page':
        options.pages.push(values[0])
        break
      case '--at': {
        const width = positive(values[0], flag)
        if (!Number.isInteger(width))
          throw new UsageError(`--at needs whole pixels, got ${values[0]}`)
        options.widths.push(width)
        break
      }
      case '--shots':
        options.shots = values[0]
        break
      case '--ready-timeout':
        options.readyTimeoutSeconds = positive(values[0], flag)
        break
      case '--no-hscroll':
        options.assertions.push({ kind: 'no-hscroll', selectors: [] })
        break
      case '--inside':
      case '--visible':
      case '--hidden':
        options.assertions.push({ kind: flag.slice(2), selectors: values })
        break
      case '--no-overlap':
        options.assertions.push({ kind: 'no-overlap', selectors: values })
        break
      default:
        options.assertions.push({ kind: 'attr', selectors: [values[0]], ...parseAttribute(values[1]) })
    }
  }
  if (options.serve === undefined)
    throw new UsageError('--serve is required')
  if (options.pages.length === 0)
    throw new UsageError('at least one --page is required')
  if (options.assertions.length === 0)
    throw new UsageError('at least one assertion is required')
  return { ...options, widths: options.widths.length === 0 ? DEFAULT_WIDTHS : options.widths }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address()
      probe.close(() => resolve(port))
    })
  })
}

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

function answers(port) {
  return new Promise((resolve) => {
    const request = http.get({ host: '127.0.0.1', port, path: '/', timeout: 1000 }, (response) => {
      response.resume()
      resolve(true)
    })
    request.once('error', () => resolve(false))
    request.once('timeout', () => {
      request.destroy()
      resolve(false)
    })
  })
}

function startServer(command, port) {
  const child = spawn(command.replaceAll('{port}', String(port)), { shell: true, detached: true, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, PORT: String(port) } })
  const server = { child, exit: undefined, stderr: '' }
  child.stderr.on('data', (chunk) => {
    server.stderr = (server.stderr + chunk).slice(-STDERR_TAIL)
  })
  child.once('exit', (code, signal) => {
    server.exit = { code, signal }
  })
  child.once('error', (error) => {
    server.exit = { code: null, signal: error.message }
  })
  return server
}

async function waitUntilReady(server, port, timeoutSeconds) {
  const deadline = Date.now() + timeoutSeconds * 1000
  while (Date.now() < deadline) {
    if (server.exit !== undefined)
      throw new Unobserved(`the serve command exited (${server.exit.code ?? server.exit.signal}) before port ${port} answered${server.stderr === '' ? '' : `: ${server.stderr.trim()}`}`)
    if (await answers(port))
      return
    await sleep(READY_POLL_MS)
  }
  throw new Unobserved(`port ${port} did not answer within ${timeoutSeconds}s of the serve command starting`)
}

function signalGroup(server, signal) {
  try {
    process.kill(-server.child.pid, signal)
  }
  catch {}
}

async function stopServer(server) {
  if (server.exit === undefined) {
    signalGroup(server, 'SIGTERM')
    const deadline = Date.now() + STOP_GRACE_MS
    while (server.exit === undefined && Date.now() < deadline)
      await sleep(READY_POLL_MS)
  }
  signalGroup(server, 'SIGKILL')
  server.child.stderr.destroy()
}

async function loadChromium() {
  const found = spawnSync('npx', ['--yes', '--package', PLAYWRIGHT_CORE, '-c', 'command -v playwright-core'], { encoding: 'utf8' })
  const binary = (found.stdout ?? '').trim().split('\n').at(-1)
  if (found.status !== 0 || binary === '' || binary === undefined)
    throw new Unobserved(`npx could not provide ${PLAYWRIGHT_CORE}${found.error === undefined ? '' : ` (${found.error.message})`}`)
  const library = await import(pathToFileURL(path.join(path.dirname(realpathSync(binary)), 'index.mjs')))
  return library.chromium
}

async function launchChrome() {
  const chromium = await loadChromium()
  try {
    return await chromium.launch({ channel: 'chrome' })
  }
  catch (error) {
    throw new Unobserved(`system Chrome could not be launched: ${String(error.message).split('\n')[0]}`)
  }
}

function measure({ selectors, attribute }) {
  const rectOf = (element) => {
    const box = element.getBoundingClientRect()
    const style = getComputedStyle(element)
    return {
      left: box.left,
      right: box.right,
      top: box.top,
      bottom: box.bottom,
      width: box.width,
      height: box.height,
      display: style.display,
      visibility: style.visibility,
      attribute: attribute === undefined ? null : element.getAttribute(attribute),
    }
  }
  return {
    innerWidth: window.innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    groups: selectors.map(selector => [...document.querySelectorAll(selector)].map(rectOf)),
  }
}

async function observe(page, assertion) {
  try {
    return await page.evaluate(measure, { selectors: assertion.selectors, attribute: assertion.name })
  }
  catch (error) {
    throw new Unobserved(`${assertionLabel(assertion)} could not be measured: ${String(error.message).split('\n')[0]}`)
  }
}

function prepareShots(root) {
  try {
    mkdirSync(root, { recursive: true })
    const runs = readdirSync(root).filter(name => RUN_DIRECTORY.test(name)).sort()
    for (const old of runs.slice(0, Math.max(0, runs.length - (KEPT_RUNS - 1))))
      rmSync(path.join(root, old), { recursive: true, force: true })
    const run = path.join(root, `${new Date().toISOString().replace(/[-:.]/g, '')}-${process.pid}`)
    mkdirSync(run)
    return run
  }
  catch (error) {
    process.stderr.write(`screenshots unavailable: ${error.message}\n`)
    return undefined
  }
}

function shotName(pagePath, width, pageCount) {
  return pageCount === 1 ? `${width}.png` : `${pagePath.replace(/[^\w.-]+/g, '_')}-${width}.png`
}

async function takeShot(page, file, report) {
  try {
    await page.screenshot({ path: file })
    report.push(`screenshot ${file}`)
  }
  catch (error) {
    process.stderr.write(`screenshot failed: ${String(error.message).split('\n')[0]}\n`)
  }
}

async function load(page, base, pagePath) {
  try {
    return await page.goto(`${base}${pagePath}`, { waitUntil: 'load' })
  }
  catch (error) {
    throw new Unobserved(`${pagePath} could not be loaded: ${String(error.message).split('\n')[0]}`)
  }
}

async function witnessPage(page, base, pagePath, width, assertions) {
  const where = `at ${pagePath} @${width}`
  const response = await load(page, base, pagePath)
  if (response !== null && !response.ok())
    return [{ holds: false, text: `FAIL page: HTTP ${response.status()} ${where}` }]
  const lines = []
  for (const assertion of assertions) {
    const verdict = judge(assertion, await observe(page, assertion))
    lines.push({ holds: verdict.holds, text: `${verdict.holds ? 'ok  ' : 'FAIL'} ${assertionLabel(assertion)}: ${verdict.detail} ${where}` })
  }
  return lines
}

export async function witness(options) {
  const report = []
  const port = await freePort()
  const server = startServer(options.serve, port)
  let browser
  try {
    await waitUntilReady(server, port, options.readyTimeoutSeconds)
    browser = await launchChrome()
    const shots = prepareShots(options.shots)
    let holds = true
    for (const pagePath of options.pages) {
      for (const width of options.widths) {
        const context = await browser.newContext({ viewport: { width, height: VIEWPORT_HEIGHT } })
        const page = await context.newPage()
        for (const line of await witnessPage(page, `http://127.0.0.1:${port}`, pagePath, width, options.assertions)) {
          report.push(line.text)
          holds = holds && line.holds
        }
        if (shots !== undefined)
          await takeShot(page, path.join(shots, shotName(pagePath, width, options.pages.length)), report)
        await context.close()
      }
    }
    return { code: holds ? EXIT_HOLDS : EXIT_FALSE, report }
  }
  finally {
    await browser?.close().catch(() => {})
    await stopServer(server)
  }
}

function isEntry() {
  return process.argv[1] != null && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
}

async function main() {
  try {
    const result = await witness(parseArguments(process.argv.slice(2)))
    process.stdout.write(`${result.report.join('\n')}\n`)
    process.exit(result.code)
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
