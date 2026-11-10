import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, describe, expect, it, vi } from 'vitest'

const SCRIPT = path.resolve(import.meta.dirname, '..', 'scripts/construct/browser-lab.mjs')

interface Route {
  fulfill: (answer: { path: string }) => Promise<void> | void
}

interface RoutedContext {
  route: (pattern: string, handler: (route: Route) => unknown) => Promise<void>
}

interface ConsoleCall {
  type: string
  args: { value: string }[]
  executionContextId: number
  timestamp: number
}

interface Visited {
  title: string
  text: string
  messages: { level: string, text: string, world: string, at: string }[]
}

interface BrowserLab {
  parseArguments: (argv: string[]) => { route: { pattern: string, file: string }[], listenMs: number }
  visit: (context: unknown, url: string, how: { settleMs: number }) => Promise<Visited>
  routeRequests: (context: RoutedContext, routes: { pattern: string, file: string }[]) => Promise<void>
  routeServiceWorkers: (env: Record<string, string | undefined>, contextOptions: Record<string, unknown>) => Record<string, unknown>
  SERVICE_WORKER_NETWORK_OFF: string
  UsageError: new () => Error
  Unobserved: new () => Error
}

const { parseArguments, visit, routeRequests, routeServiceWorkers, SERVICE_WORKER_NETWORK_OFF, UsageError, Unobserved } = await import(pathToFileURL(SCRIPT).href) as BrowserLab

const workspace = mkdtempSync(path.join(tmpdir(), 'browser-lab-route-'))
const CONFIG = path.join(workspace, 'config.json')
writeFileSync(CONFIG, '{"label":"routed"}')

afterAll(() => rmSync(workspace, { recursive: true, force: true }))

function recordingContext() {
  const handlers: { pattern: string, handler: (route: Route) => unknown }[] = []
  const route = async (pattern: string, handler: (route: Route) => unknown) => {
    handlers.push({ pattern, handler })
  }
  return { handlers, context: { route } }
}

const FIRST_CHECK_AT = Date.UTC(2026, 10, 4, 12, 0, 1)
const SECOND_CHECK_AT = Date.UTC(2026, 10, 4, 12, 0, 11)
const SECOND_CHECK_AFTER_LOAD_MS = 20
const SETTLE_MS = 200

function pageWithTwoEngineChecks() {
  let cartRendered = false
  let hear: (call: ConsoleCall) => void = () => {}
  let loaded: () => void = () => {}
  const load = new Promise<void>((resolve) => {
    loaded = resolve
  })
  const check = (text: string, timestamp: number): ConsoleCall => ({ type: 'log', args: [{ value: text }], executionContextId: 1, timestamp })
  const page = {
    on: () => {},
    goto: async () => {
      hear(check('engine: missing selectors', FIRST_CHECK_AT))
      loaded()
      return { status: () => 200 }
    },
    title: async () => (cartRendered ? 'Cart' : 'Loading'),
    evaluate: async () => (cartRendered ? 'two items' : ''),
  }
  const session = {
    on: (event: string, listener: (call: ConsoleCall) => void) => {
      if (event === 'Runtime.consoleAPICalled')
        hear = listener
    },
    send: async () => {},
  }
  const renderCart = (): void => {
    cartRendered = true
    hear(check('engine: applied', SECOND_CHECK_AT))
  }
  return { context: { newPage: async () => page, newCDPSession: async () => session }, load, renderCart }
}

async function visitWhileTheCartRenders(): Promise<Visited> {
  vi.useFakeTimers()
  try {
    const { context, load, renderCart } = pageWithTwoEngineChecks()
    const visiting = visit(context, 'http://shop.invalid/cart', { settleMs: SETTLE_MS })
    await load
    await vi.advanceTimersByTimeAsync(SECOND_CHECK_AFTER_LOAD_MS)
    renderCart()
    await vi.runAllTimersAsync()
    return await visiting
  }
  finally {
    vi.useRealTimers()
  }
}

describe('page settling', () => {
  it('page reports every engine check with its timestamp instead of only the first', async () => {
    const seen = await visitWhileTheCartRenders()
    expect(seen.messages).toEqual([
      { level: 'log', text: 'engine: missing selectors', world: 'page', at: new Date(FIRST_CHECK_AT).toISOString() },
      { level: 'log', text: 'engine: applied', world: 'page', at: new Date(SECOND_CHECK_AT).toISOString() },
    ])
  })

  it('the page is read after the settle window, not at load', async () => {
    const seen = await visitWhileTheCartRenders()
    expect(seen).toMatchObject({ title: 'Cart', text: 'two items' })
  })

  it('page --route settles by default, --for sets the window, and a page with no route does not wait', () => {
    const routed = ['page', 'http://x', '--route', '**/config', 'config.json']
    expect(parseArguments(routed).listenMs).toBe(15_000)
    expect(parseArguments([...routed, '--for', '30000']).listenMs).toBe(30_000)
    expect(parseArguments(['page', 'http://x']).listenMs).toBe(0)
    expect(parseArguments(['logs', '--extension', 'ext', '--route', '**/config', 'config.json']).listenMs).toBe(2000)
  })
})

describe('--route', () => {
  it('route substitutes a service worker request', async () => {
    const options = parseArguments(['sw-eval', 'fetch(\'http://lab-nowhere.invalid/config\').then(answer => answer.json())', '--extension', 'ext', '--route', '**/config', CONFIG])
    const { handlers, context } = recordingContext()
    await routeRequests(context, options.route)
    const answers: { path: string }[] = []
    await handlers[0]!.handler({ fulfill: answer => void answers.push(answer) })
    expect(handlers.map(({ pattern }) => pattern)).toEqual(['**/config'])
    expect(answers).toEqual([{ path: CONFIG }])
    const env: Record<string, string | undefined> = { [SERVICE_WORKER_NETWORK_OFF]: '1', KEPT: 'yes' }
    expect(routeServiceWorkers(env, { serviceWorkers: 'block', headless: true })).toEqual({ serviceWorkers: 'allow', headless: true })
    expect(env).toEqual({ KEPT: 'yes' })
  })

  it.each([['info'], ['storage'], ['logs'], ['network'], ['popup'], ['options']])('%s takes --route', (command) => {
    expect(parseArguments([command, '--extension', 'ext', '--route', '**/config', 'config.json']).route).toEqual([{ pattern: '**/config', file: 'config.json' }])
  })

  it('hands refuses --route, its browser is not the lab context', () => {
    expect(() => parseArguments(['hands', '--extension', 'ext', '--profile', 'p', '--route', '**/config', 'config.json', '--', 'open'])).toThrow(UsageError)
  })

  it('a route file that does not exist is unobserved before any route is installed', async () => {
    const { handlers, context } = recordingContext()
    await expect(routeRequests(context, [{ pattern: '**/config', file: path.join(workspace, 'missing.json') }])).rejects.toThrow(Unobserved)
    expect(handlers).toEqual([])
  })
})
