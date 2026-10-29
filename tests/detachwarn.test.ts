import type { Ui, Writer } from '../src/ui/console.js'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BUS_DB_VARIABLE, DECISIONS_FILE } from '../scripts/core/bus-path.js'
import { HANDOFF_DIR } from '../scripts/core/handoff-dir.js'
import { readAttachRecord, runAttach } from '../src/commands/attach/index.js'
import { askDetach } from '../src/commands/detach/index.js'
import { createUi } from '../src/ui/console.js'
import { PLAIN_LORE } from '../src/ui/lore.js'
import { resolveTheme } from '../src/ui/theme.js'
import { useIsolatedHome } from './isolated-home.js'

const EXISTING_MONOREPO = path.join(import.meta.dirname, 'fixtures/existing-monorepo')
const DAEMON_RUN = '.construct/daemon/20261028T183454462Z-43263'
const DAEMON_RUN_PATHS = 4
const HANDOFF_PATHS = 5
const ARCHIVE_PATHS = 3
const TOTAL_LINE_END = ' in all.'

useIsolatedHome()

let namedBus: string | undefined
beforeEach(() => {
  namedBus = process.env[BUS_DB_VARIABLE]
  delete process.env[BUS_DB_VARIABLE]
})
afterEach(() => {
  if (namedBus !== undefined)
    process.env[BUS_DB_VARIABLE] = namedBus
})

function capturing(): { ui: Ui, output: () => string } {
  let text = ''
  const write: Writer = (chunk) => {
    text += chunk
  }
  return { ui: createUi(resolveTheme({ plain: true }), write), output: () => text }
}

function git(dir: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: dir })
}

function write(file: string, content: string): void {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, content)
}

async function attachedWithHistory(): Promise<{ dir: string, factory: string }> {
  const dir = mkdtempSync(path.join(tmpdir(), 'construct-detachwarn-'))
  cpSync(EXISTING_MONOREPO, dir, { recursive: true })
  git(dir, 'init', '-q')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-qm', 'base')
  const quiet = capturing().ui
  expect((await runAttach(quiet, { dir, harness: 'pnpm run quality', requiredCheck: 'gate', yes: true })).status).toBe('done')
  const factory = readAttachRecord(dir)?.factoryBeside?.home
  if (factory == null)
    throw new Error('attach deployed no factory beside the repository')
  write(path.join(dir, DAEMON_RUN, 'caa', 'evidence.json'), '{}\n')
  write(path.join(dir, DAEMON_RUN, 'caa', 'console.json'), '[]\n')
  write(path.join(factory, HANDOFF_DIR, 'miko.md'), 'handoff\n')
  write(path.join(factory, HANDOFF_DIR, 'archive', '0001.md'), 'one\n')
  write(path.join(factory, HANDOFF_DIR, 'archive', '0002.md'), 'two\n')
  write(path.join(factory, DECISIONS_FILE), 'decisions\n')
  return { dir, factory }
}

function listOf(output: string): string {
  const start = output.indexOf(PLAIN_LORE.detachGoes)
  const end = output.indexOf(TOTAL_LINE_END, start)
  return output.slice(start, end + TOTAL_LINE_END.length)
}

function expectListNames(list: string, dir: string, factory: string): void {
  expect(list).toContain(PLAIN_LORE.detachGoesEntry(DAEMON_RUN, DAEMON_RUN_PATHS))
  expect(list).toContain(PLAIN_LORE.detachGoesEntry(`${factory}/${HANDOFF_DIR}`, HANDOFF_PATHS))
  expect(list).toContain(PLAIN_LORE.detachGoesEntry(`${factory}/${HANDOFF_DIR}/archive`, ARCHIVE_PATHS))
  expect(list).toContain(PLAIN_LORE.detachGoesEntry(`${factory}/${DECISIONS_FILE}`, 1))
  expect(list).toMatch(/\d+ paths in all\./)
  expect(existsSync(dir)).toBe(true)
}

describe('detach warns before it removes', () => {
  it('detach lists what goes and asks before removing', async () => {
    const { dir, factory } = await attachedWithHistory()
    const { ui, output } = capturing()
    const asked: string[] = []
    const declined = await askDetach(ui, { dir, yes: false }, { confirm: async (message) => {
      asked.push(output())
      expect(message).toBe(PLAIN_LORE.detachConfirm)
      return false
    } })

    expect(declined.status).toBe('aborted')
    expect(asked).toHaveLength(1)
    expectListNames(listOf(asked[0]), dir, factory)
    expect(output()).toContain(PLAIN_LORE.detachAborted)
    expect(existsSync(path.join(dir, DAEMON_RUN, 'caa', 'evidence.json'))).toBe(true)
    expect(existsSync(path.join(factory, HANDOFF_DIR, 'archive', '0001.md'))).toBe(true)
    expect(existsSync(path.join(dir, '.construct/attach.json'))).toBe(true)

    const unasked = capturing()
    expect((await askDetach(unasked.ui, { dir, yes: false })).status).toBe('aborted')
    expect(unasked.output()).toContain(PLAIN_LORE.detachNeedsTerminal)
    expect(existsSync(path.join(dir, '.construct/attach.json'))).toBe(true)

    const confirmed = await askDetach(capturing().ui, { dir, yes: false }, { confirm: async () => true })
    expect(confirmed.status).toBe('done')
    expect(existsSync(path.join(dir, DAEMON_RUN))).toBe(false)
    expect(existsSync(factory)).toBe(false)
  })

  it('detach --yes prints the same list', async () => {
    const { dir, factory } = await attachedWithHistory()
    const asking = capturing()
    await askDetach(asking.ui, { dir, yes: false }, { confirm: async () => false })

    const { ui, output } = capturing()
    const result = await askDetach(ui, { dir, yes: true })

    expect(result.status).toBe('done')
    const list = listOf(output())
    expectListNames(list, dir, factory)
    expect(list).toBe(listOf(asking.output()))
    expect(existsSync(path.join(dir, DAEMON_RUN))).toBe(false)
    expect(existsSync(path.join(factory, HANDOFF_DIR))).toBe(false)
  })
})
