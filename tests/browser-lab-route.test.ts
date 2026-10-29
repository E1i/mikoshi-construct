import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'

const SCRIPT = path.resolve(import.meta.dirname, '..', 'scripts/construct/browser-lab.mjs')

interface Route {
  fulfill: (answer: { path: string }) => Promise<void> | void
}

interface RoutedContext {
  route: (pattern: string, handler: (route: Route) => unknown) => Promise<void>
}

interface BrowserLab {
  parseArguments: (argv: string[]) => { route: { pattern: string, file: string }[] }
  routeRequests: (context: RoutedContext, routes: { pattern: string, file: string }[]) => Promise<void>
  routeServiceWorkers: (env: Record<string, string | undefined>, contextOptions: Record<string, unknown>) => Record<string, unknown>
  SERVICE_WORKER_NETWORK_OFF: string
  UsageError: new () => Error
  Unobserved: new () => Error
}

const { parseArguments, routeRequests, routeServiceWorkers, SERVICE_WORKER_NETWORK_OFF, UsageError, Unobserved } = await import(pathToFileURL(SCRIPT).href) as BrowserLab

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
