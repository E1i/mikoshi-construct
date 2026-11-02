import type { FactoryChecklist, FactoryItemName } from '../src/commands/doctor/index.js'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { appendEvent, openBus } from '../scripts/core/db.js'
import { WINDOW_HEARTBEAT } from '../scripts/core/events.js'
import { HANDOFF_DIR_VARIABLE } from '../scripts/core/handoff-dir.js'
import { DOCTOR_EXIT, factoryChecklist, printFactoryChecklist } from '../src/commands/doctor/index.js'
import { runInit } from '../src/commands/init.js'
import { createUi, silentWriter } from '../src/ui/console.js'
import { LORE, PLAIN_LORE } from '../src/ui/lore.js'
import { resolveTheme } from '../src/ui/theme.js'

const NOW = new Date('2026-11-02T12:00:00.000Z')
const EDIT_LOCAL_SETTINGS = '$EDITOR .claude/settings.local.json'

interface Factory {
  dir: string
  bus: string
  home: string
  handoffs: string
}

function scratch(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix))
}

async function readyFactory(): Promise<Factory> {
  const dir = scratch('construct-doctorstart-')
  mkdirSync(path.join(dir, '.git'))
  const home = scratch('construct-doctorstart-home-')
  await runInit(createUi(resolveTheme({ plain: true }), silentWriter), { dir, preset: 'node-backend', ai: 'claude', yes: true, dryRun: false, env: {}, home })
  const factory = { dir, home, bus: path.join(scratch('construct-doctorstart-bus-'), 'bus.db'), handoffs: scratch('construct-doctorstart-handoff-') }
  const ts = new Date(NOW.getTime() - 60_000).toISOString()
  const db = openBus(factory.bus)
  try {
    appendEvent(db, { ts, type: WINDOW_HEARTBEAT, actor: 'worker:window:tab-1', cardId: null, pr: null, head: null, dedupeKey: `${WINDOW_HEARTBEAT}:tab-1:${ts}`, payload: { session: 'tab-1', mode: 'tab' }, legacy: false })
  }
  finally {
    db.close()
  }
  const decisions = ['merge', 'update'].map((queue, index) => `- D-${index + 1} · 2026-11-02 — [owner] allow-live ${queue} · until 2026-11-02T18:00Z · decisions:add`)
  writeFileSync(path.join(path.dirname(factory.bus), 'owner-decisions.md'), `# Owner decisions\n\n${decisions.join('\n')}\n`)
  handoff(factory, 'STATUS: CONTINUE')
  return factory
}

function handoff(factory: Factory, ...lines: string[]): string {
  const file = path.join(factory.handoffs, 'miko.md')
  writeFileSync(file, `# Handoff\n\n${lines.join('\n')}\n`)
  return file
}

function localSettings(factory: Factory, settings: string): void {
  writeFileSync(path.join(factory.dir, '.claude/settings.local.json'), settings)
}

function check(factory: Factory): FactoryChecklist {
  return factoryChecklist(factory.dir, { env: { CONSTRUCT_BUS_DB: factory.bus, [HANDOFF_DIR_VARIABLE]: factory.handoffs }, home: factory.home, now: NOW })
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

function writeContinue(file: string): string {
  return `miko handoff write ${file} <draft ending STATUS: CONTINUE>`
}

describe('doctor --factory checks that the factory can start without the owner', () => {
  it('doctor --factory is red when the window handoff is not CONTINUE', async () => {
    const factory = await readyFactory()
    expect(red(check(factory))).toEqual({})
    for (const status of ['OWNER', 'DONE', 'STOP']) {
      const file = handoff(factory, 'STATUS: CONTINUE', `STATUS: ${status}`)
      const checklist = check(factory)
      expect(red(checklist), status).toEqual({ 'window-continue': writeContinue(file) })
      const { text, exit } = printed(checklist)
      expect(exit).toBe(DOCTOR_EXIT.notOk)
      expect(text).toContain(PLAIN_LORE.factoryItem['window-continue'])
      expect(text).toContain(PLAIN_LORE.factoryRun(writeContinue(file)))
    }
    expect(red(check({ ...factory, handoffs: scratch('construct-doctorstart-no-handoff-') }))).toEqual({ 'window-continue': expect.stringContaining('<draft ending STATUS: CONTINUE>') })
    handoff(factory, 'STATUS: OWNER', 'STATUS: CONTINUE — the owner answered')
    expect(red(check(factory))).toEqual({})
  })

  it('doctor --factory is red when settings.local.json widens card-session permissions', async () => {
    const factory = await readyFactory()
    localSettings(factory, JSON.stringify({ enabledPlugins: {}, permissions: { allow: [], deny: ['Bash(rm:*)'] } }))
    expect(red(check(factory))).toEqual({})
    const widening = [
      { permissions: { allow: ['Bash(gh pr merge:*)'] } },
      { permissions: { additionalDirectories: ['/elsewhere'] } },
      { permissions: { defaultMode: 'bypassPermissions' } },
      { sandbox: { excludedCommands: ['git'] } },
    ]
    for (const settings of widening) {
      localSettings(factory, JSON.stringify(settings))
      const checklist = check(factory)
      expect(red(checklist), JSON.stringify(settings)).toEqual({ 'card-permissions': EDIT_LOCAL_SETTINGS })
      const { text, exit } = printed(checklist)
      expect(exit).toBe(DOCTOR_EXIT.notOk)
      expect(text).toContain(PLAIN_LORE.factoryItem['card-permissions'])
    }
    localSettings(factory, '{ not json')
    expect(red(check(factory))).toEqual({ 'card-permissions': EDIT_LOCAL_SETTINGS })
  })

  it('every new item names in both lores what would make it go', () => {
    for (const lore of [LORE, PLAIN_LORE]) {
      expect(lore.factoryItem['card-permissions']).toContain('~/.claude/settings.json')
      expect(lore.factoryItem['window-continue']).toContain('STATUS: CONTINUE')
    }
  })
})
