import type { FactoryChecklist, FactoryItemName } from '../src/commands/doctor/index.js'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { runCommand } from 'citty'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BUS_DB_VARIABLE } from '../scripts/core/bus-path.js'
import { appendEvent, openBus } from '../scripts/core/db.js'
import { WINDOW_HEARTBEAT } from '../scripts/core/events.js'
import { DOCTOR_EXIT, DOCTOR_JSON_SCHEMA_VERSION, FACTORY_ITEMS, factoryChecklist, factoryChecklistExit, factoryChecklistJson, printFactoryChecklist } from '../src/commands/doctor/index.js'
import { runInit } from '../src/commands/init.js'
import { WINDOW_SILENT_MS } from '../src/commands/liveness.js'
import { applySync } from '../src/commands/sync/index.js'
import { readManifest, writeManifest } from '../src/manifest.js'
import { MIKOSHI_PNPM } from '../src/presets/index.js'
import { main } from '../src/program.js'
import { createUi, silentWriter } from '../src/ui/console.js'
import { LORE, PLAIN_LORE } from '../src/ui/lore.js'
import { resolveTheme } from '../src/ui/theme.js'
import { VERSION } from '../src/version.js'

const NOW = new Date('2026-10-30T12:00:00.000Z')
const IN_FORCE_UNTIL = '2026-10-30T18:00Z'
const LAPSED_UNTIL = '2026-10-30T06:00Z'
const SYNC_APPLY = 'construct sync --apply'
const BRIEF_AGENT = '.claude/agents/brief.md'
const REVIEW_AGENT = '.claude/agents/review.md'
const GHOST_PROTOCOL = 'construct say "ghost-protocol 6h" && construct-factory --mode ghost-protocol'

interface Factory {
  dir: string
  bus: string
  home: string
}

function scratch(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix))
}

async function initialised(): Promise<Factory> {
  const dir = scratch('construct-doctor-factory-')
  mkdirSync(path.join(dir, '.git'))
  const home = scratch('construct-doctor-factory-home-')
  await runInit(createUi(resolveTheme({ plain: true }), silentWriter), { dir, preset: 'node-backend', ai: 'claude', yes: true, dryRun: false, env: {}, home })
  return { dir, home, bus: path.join(scratch('construct-doctor-factory-bus-'), 'bus.db') }
}

function beat(bus: string, ageMs: number): void {
  const ts = new Date(NOW.getTime() - ageMs).toISOString()
  const db = openBus(bus)
  try {
    appendEvent(db, { ts, type: WINDOW_HEARTBEAT, actor: 'worker:window:tab-1', cardId: null, pr: null, head: null, dedupeKey: `${WINDOW_HEARTBEAT}:tab-1:${ts}`, payload: { session: 'tab-1', mode: 'tab' }, legacy: false })
  }
  finally {
    db.close()
  }
}

function decide(bus: string, until: string, queues: string[] = ['merge', 'update']): void {
  const lines = queues.map((queue, index) => `- D-${index + 1} · 2026-10-30 — [owner] allow-live ${queue} · until ${until} · decisions:add`)
  writeFileSync(path.join(path.dirname(bus), 'owner-decisions.md'), `# Owner decisions\n\n${lines.join('\n')}\n`)
}

async function readyFactory(): Promise<Factory> {
  const factory = await initialised()
  beat(factory.bus, 60_000)
  decide(factory.bus, IN_FORCE_UNTIL)
  return factory
}

function check(factory: Factory): FactoryChecklist {
  return factoryChecklist(factory.dir, { env: { CONSTRUCT_BUS_DB: factory.bus }, home: factory.home, now: NOW })
}

function red(checklist: FactoryChecklist): Partial<Record<FactoryItemName, string | null>> {
  return Object.fromEntries(checklist.items.filter(item => !item.goes).map(item => [item.item, item.command]))
}

function printed(checklist: FactoryChecklist): { text: string, exit: number } {
  const lines: string[] = []
  const exit = printFactoryChecklist(createUi(resolveTheme({ plain: true }), (text: string) => {
    lines.push(text)
  }), checklist)
  return { text: lines.join(''), exit }
}

function editJson(file: string, edit: (json: Record<string, unknown>) => void): void {
  const json = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  edit(json)
  writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`)
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

async function factoryJsonThroughProgram(factory: Factory): Promise<{ exit: typeof process.exitCode, output: string }> {
  const written: string[] = []
  const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    written.push(String(chunk))
    return true
  })
  const previousExit = process.exitCode
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  vi.stubEnv(BUS_DB_VARIABLE, factory.bus)
  try {
    process.exitCode = undefined
    await runCommand(main, { rawArgs: ['doctor', '--factory', '--json', '--plain', '--dir', factory.dir] })
    return { exit: process.exitCode, output: written.join('') }
  }
  finally {
    write.mockRestore()
    process.exitCode = previousExit
  }
}

describe('doctor --factory says goes or does not go for every item of PARITY and ONEWORD', () => {
  it('a fresh init with a fresh window heartbeat and the ghost-protocol decisions goes on every item', async () => {
    const checklist = check(await readyFactory())
    expect(checklist.items.map(item => item.item)).toEqual(Object.keys(FACTORY_ITEMS))
    expect(red(checklist)).toEqual({})
    expect(checklist.goes).toBe(true)
    const { text, exit } = printed(checklist)
    expect(exit).toBe(DOCTOR_EXIT.ok)
    expect(text).toContain(PLAIN_LORE.factoryVerdict(true, 0))
    expect(text).not.toContain(PLAIN_LORE.factoryStalls)
  })

  it('a fresh init with no window and no owner word does not go, and names the command for each red item', async () => {
    const checklist = check(await initialised())
    expect(red(checklist)).toEqual({ 'window-live': 'claude', 'live-merge': GHOST_PROTOCOL, 'live-update': GHOST_PROTOCOL })
    const { text, exit } = printed(checklist)
    expect(exit).toBe(DOCTOR_EXIT.notOk)
    expect(text).toContain(PLAIN_LORE.factoryRun(GHOST_PROTOCOL))
    expect(text).toContain(PLAIN_LORE.factoryVerdict(false, 3))
  })

  it('a window heartbeat older than the silence does not go', async () => {
    const factory = await initialised()
    beat(factory.bus, WINDOW_SILENT_MS + 1)
    decide(factory.bus, IN_FORCE_UNTIL)
    expect(red(check(factory))).toEqual({ 'window-live': 'claude' })
  })

  it('allow-live decisions past their term do not go, and one queue alone leaves the other red', async () => {
    const lapsed = await initialised()
    beat(lapsed.bus, 60_000)
    decide(lapsed.bus, LAPSED_UNTIL)
    expect(red(check(lapsed))).toEqual({ 'live-merge': GHOST_PROTOCOL, 'live-update': GHOST_PROTOCOL })
    const mergeOnly = await initialised()
    beat(mergeOnly.bus, 60_000)
    decide(mergeOnly.bus, IN_FORCE_UNTIL, ['merge'])
    expect(red(check(mergeOnly))).toEqual({ 'live-update': GHOST_PROTOCOL })
  })

  it('a factory file the record never carried does not go until construct sync --apply', async () => {
    const factory = await readyFactory()
    const manifest = readManifest(factory.dir)!
    const files = { ...manifest.files }
    delete files[BRIEF_AGENT]
    writeManifest(factory.dir, { ...manifest, files })
    rmSync(path.join(factory.dir, BRIEF_AGENT))
    expect(red(check(factory))).toEqual({ 'factory-files': SYNC_APPLY })
    applySync(factory.dir, VERSION)
    expect(red(check(factory))).toEqual({})
  })

  it('a recorded factory file the tree lost, which sync never rewrites, names git restore', async () => {
    const factory = await readyFactory()
    rmSync(path.join(factory.dir, BRIEF_AGENT))
    expect(red(check(factory))).toEqual({ 'factory-files': `git restore -- ${BRIEF_AGENT}` })
  })

  it('a recorded file the tree lost beside a file the record never carried names git restore, then construct sync --apply, and following both goes', async () => {
    const factory = await readyFactory()
    const manifest = readManifest(factory.dir)!
    const files = { ...manifest.files }
    delete files[REVIEW_AGENT]
    writeManifest(factory.dir, { ...manifest, files })
    const lost = readFileSync(path.join(factory.dir, BRIEF_AGENT), 'utf8')
    rmSync(path.join(factory.dir, BRIEF_AGENT))
    rmSync(path.join(factory.dir, REVIEW_AGENT))
    expect(red(check(factory))).toEqual({ 'factory-files': `git restore -- ${BRIEF_AGENT} && ${SYNC_APPLY}` })
    writeFileSync(path.join(factory.dir, BRIEF_AGENT), lost)
    applySync(factory.dir, VERSION)
    expect(red(check(factory))).toEqual({})
  })

  it('settings.json without the factory hooks does not go until construct sync --apply', async () => {
    const factory = await readyFactory()
    editJson(path.join(factory.dir, '.claude/settings.json'), (settings) => {
      delete settings.hooks
    })
    expect(red(check(factory))).toEqual({ 'factory-hooks': SYNC_APPLY })
    applySync(factory.dir, VERSION)
    expect(red(check(factory))).toEqual({})
  })

  it('a pnpm pinned below the mikoshi floor, or a .gitignore without .pnpm-store/, does not go', async () => {
    const factory = await readyFactory()
    editJson(path.join(factory.dir, 'package.json'), (manifest) => {
      manifest.packageManager = 'pnpm@9.15.0'
    })
    const gitignore = path.join(factory.dir, '.gitignore')
    writeFileSync(gitignore, readFileSync(gitignore, 'utf8').replace('.pnpm-store/\n', ''))
    expect(red(check(factory))).toEqual({ 'pnpm-floor': `corepack use pnpm@${MIKOSHI_PNPM}`, 'pnpm-store-ignored': `printf '.pnpm-store/\\n' >> .gitignore` })
  })

  it('--json carries schemaVersion, goes, bus and items, and exits ok only when every item goes', async () => {
    for (const factory of [await readyFactory(), await initialised()]) {
      const checklist = check(factory)
      const json = factoryChecklistJson(checklist)
      expect(Object.keys(json)).toEqual(['schemaVersion', 'goes', 'bus', 'items'])
      expect(json).toEqual({ schemaVersion: DOCTOR_JSON_SCHEMA_VERSION, goes: checklist.goes, bus: factory.bus, items: checklist.items })
      expect(Object.keys(checklist.items[0]!)).toEqual(['item', 'slice', 'goes', 'command'])
      expect(factoryChecklistExit(checklist)).toBe(checklist.goes ? DOCTOR_EXIT.ok : DOCTOR_EXIT.notOk)
      expect(factoryChecklistExit(checklist)).toBe(printed(checklist).exit)
    }
    expect(factoryChecklistExit(check(await readyFactory()))).toBe(DOCTOR_EXIT.ok)
    expect(factoryChecklistExit(check(await initialised()))).toBe(DOCTOR_EXIT.notOk)
  })

  it('doctor --factory --json through the program writes the checklist to stdout and exits ok only when every item goes', async () => {
    const ready = await readyFactory()
    const goes = await factoryJsonThroughProgram(ready)
    expect(goes.exit).toBe(DOCTOR_EXIT.ok)
    expect(JSON.parse(goes.output)).toEqual(factoryChecklistJson(check(ready)))
    const fresh = await initialised()
    const stalls = await factoryJsonThroughProgram(fresh)
    expect(stalls.exit).toBe(DOCTOR_EXIT.notOk)
    expect(JSON.parse(stalls.output)).toEqual(factoryChecklistJson(check(fresh)))
    expect(JSON.parse(stalls.output).goes).toBe(false)
  })

  it('every item has its line in the lore and in the plain lore', () => {
    for (const item of Object.keys(FACTORY_ITEMS)) {
      expect(LORE.factoryItem[item], item).toBeTruthy()
      expect(PLAIN_LORE.factoryItem[item], item).toBeTruthy()
    }
    expect(Object.keys(PLAIN_LORE.factoryItem).sort()).toEqual(Object.keys(FACTORY_ITEMS).sort())
    expect(Object.keys(LORE.factoryItem).sort()).toEqual(Object.keys(FACTORY_ITEMS).sort())
  })
})
