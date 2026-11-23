import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { renderAgent } from '../../supervisor/launchd/install.js'
import { BOOT_READ_SLACK_MS, bootTime, HOLD_FLAG, KEEP_ALIVE_PROGRAM, keepAlivePlist, markOfThisBoot, MIKO_FLAG, raiseByKeepAlive, restartRefusal, START_BIN, startCommandOf, STARTED_MARK, startedMarkOf, startThroughMiko } from '../../supervisor/start.js'
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
    expect(restartRefusal(busDir, () => new Date('2026-11-19T00:00:00.000Z'))).toBeNull()
  })
})

const BOOTED = new Date('2026-11-22T08:00:00.000Z')
const IN_THIS_BOOT = new Date('2026-11-22T09:00:00.000Z')
const BEFORE_THIS_BOOT = new Date('2026-11-21T09:00:00.000Z')

function freshBusDir(): string {
  const busDir = path.join(mkdtempSync(path.join(tmpdir(), 'keep-alive-')), 'bus')
  roots.push(path.dirname(busDir))
  mkdirSync(busDir, { recursive: true })
  return busDir
}

async function keepAliveRun(busDir: string, booted: () => Date | null): Promise<{ starts: number, printed: string[] }> {
  let starts = 0
  const printed: string[] = []
  await raiseByKeepAlive(busDir, async () => {
    starts += 1
    return { stdout: ['bus up'], stderr: [], exitCode: 0 }
  }, { busDb: path.join(busDir, 'bus.db'), processes: () => [], wait: async () => {}, say: () => {} }, booted, result => printed.push(...result.stdout, ...result.stderr))
  return { starts, printed }
}

describe('the start mark is bound to the boot of the machine', () => {
  it('a killed bus whose start mark is from this boot is raised by the keep-alive', async () => {
    const busDir = freshBusDir()
    await startThroughMiko(busDir, IN_THIS_BOOT, async () => ({ stdout: [], stderr: [], exitCode: 0 }))

    const run = await keepAliveRun(busDir, () => BOOTED)

    expect(run.starts).toBe(1)
    expect(run.printed).toContain('bus up')
    expect(existsSync(startedMarkOf(busDir))).toBe(true)
  })

  it('a start mark from a previous boot raises nothing', async () => {
    const busDir = freshBusDir()
    await startThroughMiko(busDir, BEFORE_THIS_BOOT, async () => ({ stdout: [], stderr: [], exitCode: 0 }))

    const run = await keepAliveRun(busDir, () => BOOTED)

    expect(run.starts).toBe(0)
    expect(run.printed.join('\n')).toContain('before this boot')
    expect(run.printed.join('\n')).toContain('miko start')
    expect(existsSync(startedMarkOf(busDir))).toBe(false)
    expect((await keepAliveRun(busDir, () => BOOTED)).starts).toBe(0)

    await startThroughMiko(busDir, new Date(BOOTED.getTime() + 60_000), async () => ({ stdout: [], stderr: [], exitCode: 0 }))
    expect((await keepAliveRun(busDir, () => BOOTED)).starts).toBe(1)
  })

  it('a mark with no readable time is not proven of this boot and raises nothing', async () => {
    const busDir = freshBusDir()
    writeFileSync(startedMarkOf(busDir), '')

    expect((await keepAliveRun(busDir, () => BOOTED)).starts).toBe(0)
    expect(existsSync(startedMarkOf(busDir))).toBe(false)
  })

  it('a factory that an install of a new package version killed within the session is raised by the keep-alive on the new version', async () => {
    const busDir = freshBusDir()
    writeFileSync(startedMarkOf(busDir), `${IN_THIS_BOOT.toISOString()}\n`)

    const run = await keepAliveRun(busDir, () => BOOTED)

    expect(run.starts).toBe(1)
    expect(KEEP_ALIVE_PROGRAM).toEqual(['/usr/bin/env', START_BIN, HOLD_FLAG])
    const plist = keepAlivePlist({ label: 'dev.mikoshi.factory.shop-0', repository: '/work/shop', path: '/usr/local/bin:/usr/bin', busDb: path.join(busDir, 'bus.db'), log: path.join(busDir, 'launchd.log'), account: null, startedMark: startedMarkOf(busDir) })
    const program = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(plist)?.[1] ?? ''
    expect([...program.matchAll(/<string>([^<]*)<\/string>/g)].map(found => found[1])).toEqual(KEEP_ALIVE_PROGRAM)
  })

  it('a keep-alive that cannot read the boot time still raises a marked factory', async () => {
    const busDir = freshBusDir()
    writeFileSync(startedMarkOf(busDir), `${BEFORE_THIS_BOOT.toISOString()}\n`)

    expect((await keepAliveRun(busDir, () => null)).starts).toBe(1)
  })

  it('the boot time is read before now, or is unknown where the system refuses it', () => {
    const booted = bootTime()
    if (booted !== null)
      expect(booted.getTime()).toBeLessThanOrEqual(Date.now())
    expect(markOfThisBoot(`${new Date(BOOTED.getTime() - BOOT_READ_SLACK_MS / 2).toISOString()}\n`, BOOTED)).toBe(true)
    expect(markOfThisBoot(`${new Date(BOOTED.getTime() - BOOT_READ_SLACK_MS * 2).toISOString()}\n`, BOOTED)).toBe(false)
  })
})
