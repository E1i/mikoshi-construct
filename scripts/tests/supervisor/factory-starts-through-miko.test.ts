import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { renderAgent } from '../../supervisor/launchd/install.js'
import { keepAlivePlist, MIKO_FLAG, restartRefusal, startCommandOf, STARTED_MARK, startedMarkOf, startThroughMiko } from '../../supervisor/start.js'
import { FACTORY_START_WORD, FACTORY_STARTER_FLAG, mikoRoute } from '../../window/miko.js'

const SCRIPTS = path.resolve(import.meta.dirname, '..', '..')
const TESTS = path.join(SCRIPTS, 'tests')
const START_SOURCE = path.join(SCRIPTS, 'supervisor', 'start.ts')
const OWNER_TEMPLATE = path.join(SCRIPTS, 'supervisor', 'launchd', 'dev.mikoshi.bus.plist')
const MIKO_SOURCE = path.join(SCRIPTS, 'window', 'miko.ts')
const BUS_DIR = '/factory/home/.construct/bus'
const LAUNCHD_KEY = /<key>(?:KeepAlive|RunAtLoad)<\/key>/

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

const RENDERERS: Record<string, () => string> = {
  [START_SOURCE]: () => keepAlivePlist({ label: 'dev.mikoshi.factory.shop-0', repository: '/work/shop', path: '/usr/bin:/bin', busDb: '/factory/home/.construct/bus.db', log: '/factory/home/.construct/bus/launchd.log', account: null, startedMark: startedMarkOf(BUS_DIR) }),
  [OWNER_TEMPLATE]: () => renderAgent(readFileSync(OWNER_TEMPLATE, 'utf8'), { factoryDir: '/work/factory', tokenSource: 'echo token', startedMark: startedMarkOf(BUS_DIR) }),
}

function sourcesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory())
      return full === TESTS || entry.name === 'node_modules' ? [] : sourcesUnder(full)
    return [full]
  })
}

function keepAliveCondition(plist: string): string | null {
  return /<key>KeepAlive<\/key>\s*<dict>\s*<key>PathState<\/key>\s*<dict>\s*<key>([^<]+)<\/key>\s*<true\/>\s*<\/dict>\s*<\/dict>/.exec(plist)?.[1] ?? null
}

describe('the factory starts only through Miko', () => {
  it('no launchd agent the factory renders starts the bus by itself', () => {
    const rendering = sourcesUnder(SCRIPTS).filter(file => LAUNCHD_KEY.test(readFileSync(file, 'utf8')))
    expect(rendering.sort()).toEqual(Object.keys(RENDERERS).sort())
    for (const [renderer, render] of Object.entries(RENDERERS)) {
      const plist = render()
      expect(plist, renderer).not.toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/)
      expect(plist, renderer).not.toMatch(/<key>KeepAlive<\/key>\s*<true\/>/)
      expect(keepAliveCondition(plist), renderer).toBe(startedMarkOf(BUS_DIR))
      expect(path.basename(keepAliveCondition(plist)!), renderer).toBe(STARTED_MARK)
    }
  })

  it('miko starts the factory bus', async () => {
    const route = mikoRoute([FACTORY_START_WORD], MIKO_SOURCE)
    expect(route).toEqual({ script: START_SOURCE, args: [FACTORY_STARTER_FLAG] })
    expect(FACTORY_STARTER_FLAG).toBe(MIKO_FLAG)
    expect(startCommandOf(route.args)).toEqual({ kind: 'start', hold: false })
    expect(startCommandOf([])).toBeNull()

    const busDir = path.join(mkdtempSync(path.join(tmpdir(), 'miko-start-')), 'bus')
    roots.push(path.dirname(busDir))
    expect(restartRefusal(busDir)?.exitCode).toBe(0)
    expect(restartRefusal(busDir)?.stdout.join('\n')).toContain('miko start')

    const started: boolean[] = []
    const result = await startThroughMiko(busDir, new Date('2026-11-20T00:00:00.000Z'), async () => {
      started.push(existsSync(startedMarkOf(busDir)))
      return { stdout: ['bus up'], stderr: [], exitCode: 0 }
    })
    expect(started).toEqual([true])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('bus up')
    expect(readFileSync(startedMarkOf(busDir), 'utf8')).toBe('2026-11-20T00:00:00.000Z\n')
    expect(restartRefusal(busDir)).toBeNull()
  })
})
