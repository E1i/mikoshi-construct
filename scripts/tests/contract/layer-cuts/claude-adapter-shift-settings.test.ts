import type { SessionSpec } from '../../../ports/client/contract.js'
import { describe, expect, it } from 'vitest'
import { repositoryReport } from '../../../contract/module-graph/report.js'
import { claudeAdapterWith } from '../../../ports/client/claude/adapter.js'
import { settingsFlag, shiftSettings } from '../../../ports/shift-settings.js'

const ADAPTER = 'scripts/ports/client/claude/adapter.ts'
const CLIENT_INDEX = 'scripts/ports/client/index.ts'
const SESSION_PORT = 'scripts/ports/session.ts'
const SHIFT_SETTINGS = 'scripts/ports/shift-settings.ts'
const GATE = 'pnpm run gate'
const WRITABLE = '/tree/.construct/report.md'

function sandboxedLaunch(): SessionSpec {
  return { kind: 'start', role: 'launch', session: 'sess-2111', cwd: '/tree', prompt: 'the card', addDirs: [], pick: { model: null }, policy: { profile: 'sandboxed', gateCommands: [GATE], writePaths: [WRITABLE], mcpOff: true } }
}

describe('the claude adapter takes the shift settings from the one who builds it', () => {
  it('repositoryReport() holds no import of scripts/ports/shift-settings.ts from the claude adapter, the client index or the session port', () => {
    const { graph } = repositoryReport()
    expect(graph.imports.filter(({ from, to }) => (from === ADAPTER || from === CLIENT_INDEX || from === SESSION_PORT) && to === SHIFT_SETTINGS)).toEqual([])
  })

  it('an adapter a root builds with the shift settings invokes a sandboxed launch with them', () => {
    const built = claudeAdapterWith({ shiftSettings, settingsFlag })
    const invocation = built.invocation(sandboxedLaunch())
    expect('args' in invocation && invocation.args).toEqual(expect.arrayContaining(['--settings']))
  })

  it('the adapter writes whatever settings its source hands it', () => {
    const adapter = claudeAdapterWith({ shiftSettings: (tree, gate, writable) => ({ tree, prepush: gate.prepush, writable }), settingsFlag: settings => ['--settings', JSON.stringify(settings)] })
    const invocation = adapter.invocation(sandboxedLaunch())
    expect('args' in invocation && invocation.args).toEqual(expect.arrayContaining(['--settings', expect.stringContaining(`"prepush":["${GATE}"]`)]))
  })
})
