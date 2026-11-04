import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const SCRIPT = path.resolve(import.meta.dirname, '..', 'scripts/construct/browser-lab.mjs')

interface Viewport {
  width: number
  height: number
}

interface Options {
  viewport: Viewport | undefined
  colorScheme: string | undefined
  press: string[] | undefined
}

interface LaunchOptions {
  viewport?: Viewport
  colorScheme?: string
}

interface BrowserLab {
  parseArguments: (argv: string[]) => Options
  persistentContextOptions: (options: Options, extension: undefined) => LaunchOptions
  visit: (context: unknown, url: string, how: { press?: string[], wait?: string }) => Promise<{ title: string }>
  UsageError: new () => Error
  Unobserved: new () => Error
}

const { parseArguments, persistentContextOptions, visit, UsageError, Unobserved } = await import(pathToFileURL(SCRIPT).href) as BrowserLab

function launchOptionsOf(...flags: string[]): LaunchOptions {
  return persistentContextOptions(parseArguments(['page', 'http://x', ...flags]), undefined)
}

function pageAnswering(press: (key: string) => Promise<void>, wait: string[] = []) {
  const page = {
    on: () => {},
    goto: async () => {
      wait.push('goto')
      return { status: () => 200 }
    },
    waitForSelector: async () => void wait.push('wait'),
    keyboard: { press },
    title: async () => wait.join(' '),
    evaluate: async () => '',
  }
  const session = { on: () => {}, send: async () => {} }
  return { newPage: async () => page, newCDPSession: async () => session }
}

describe('page takes --viewport', () => {
  it('opens the page at the width and the height given', () => {
    expect(launchOptionsOf('--viewport', '375x667').viewport).toEqual({ width: 375, height: 667 })
  })

  it('takes the width alone and supplies a height', () => {
    expect(launchOptionsOf('--viewport', '375').viewport).toEqual({ width: 375, height: 800 })
  })

  it('leaves the size to the browser when it is not given', () => {
    expect(launchOptionsOf()).not.toHaveProperty('viewport')
  })

  it.each([['0'], ['375x0'], ['x667'], ['wide'], ['375x'], ['-1']])('refuses %s', (value) => {
    expect(() => parseArguments(['page', 'http://x', '--viewport', value])).toThrow(UsageError)
  })

  it('belongs to page', () => {
    expect(() => parseArguments(['info', '--extension', 'ext', '--viewport', '375'])).toThrow(UsageError)
    expect(() => parseArguments(['hands', '--profile', 'p', '--viewport', '375', '--', 'open'])).toThrow(UsageError)
  })
})

describe('page takes --color-scheme', () => {
  it.each([['light'], ['dark']])('opens the page with prefers-color-scheme %s', (scheme) => {
    expect(launchOptionsOf('--color-scheme', scheme).colorScheme).toBe(scheme)
  })

  it('leaves the scheme to the browser when it is not given', () => {
    expect(launchOptionsOf()).not.toHaveProperty('colorScheme')
  })

  it('refuses any other scheme', () => {
    expect(() => parseArguments(['page', 'http://x', '--color-scheme', 'sepia'])).toThrow(UsageError)
  })

  it('belongs to page', () => {
    expect(() => parseArguments(['info', '--extension', 'ext', '--color-scheme', 'dark'])).toThrow(UsageError)
  })
})

describe('page takes --press', () => {
  it('splits the value into keys and chords', () => {
    expect(parseArguments(['page', 'http://x', '--press', 'Tab  Control+K Enter']).press).toEqual(['Tab', 'Control+K', 'Enter'])
  })

  it('presses each key in turn after the page loaded and the selector appeared, before the page is read', async () => {
    const steps: string[] = []
    const seen = await visit(pageAnswering(async key => void steps.push(key), steps), 'http://x', { press: ['Tab', 'Enter'], wait: '#ready' })
    expect(steps).toEqual(['goto', 'wait', 'Tab', 'Enter'])
    expect(seen.title).toBe('goto wait Tab Enter')
  })

  it('presses nothing when it is not given', async () => {
    const steps: string[] = []
    await visit(pageAnswering(async key => void steps.push(key), steps), 'http://x', {})
    expect(steps).toEqual(['goto'])
  })

  it('a key the browser does not know is unobserved', async () => {
    const refusing = pageAnswering(async (key) => {
      throw new Error(`Unknown key: "${key}"`)
    })
    await expect(visit(refusing, 'http://x', { press: ['Nope'] })).rejects.toThrow(Unobserved)
  })

  it.each([[''], ['   ']])('refuses the empty value %j', (value) => {
    expect(() => parseArguments(['page', 'http://x', '--press', value])).toThrow(UsageError)
  })

  it('belongs to page', () => {
    expect(() => parseArguments(['info', '--extension', 'ext', '--press', 'Tab'])).toThrow(UsageError)
  })
})
