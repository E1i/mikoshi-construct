import type { SessionSpec } from '../../../ports/client/contract.js'
import { describe, expect, it } from 'vitest'
import { repositoryReport } from '../../../contract/module-graph/report.js'
import { claudeAdapterWith } from '../../../ports/client/claude/adapter.js'
import { clientAdapter } from '../../../ports/session.js'
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
  it('repositoryReport() holds no import of scripts/ports/shift-settings.ts from the claude adapter or the client index, and one from the session port', () => {
    const { graph } = repositoryReport()
    expect(graph.imports.filter(({ from, to }) => (from === ADAPTER || from === CLIENT_INDEX) && to === SHIFT_SETTINGS)).toEqual([])
    expect(graph.imports.some(({ from, to }) => from === SESSION_PORT && to === SHIFT_SETTINGS)).toBe(true)
  })

  it('the adapter the session port builds invokes a sandboxed launch with the shift settings it was given', () => {
    const built = claudeAdapterWith({ shiftSettings, settingsFlag })
    const invocation = clientAdapter().invocation(sandboxedLaunch())
    expect(invocation).toEqual(built.invocation(sandboxedLaunch()))
  })

  it('the adapter writes whatever settings its source hands it', () => {
    const adapter = claudeAdapterWith({ shiftSettings: (tree, gate, writable) => ({ tree, prepush: gate.prepush, writable }), settingsFlag: settings => ['--settings', JSON.stringify(settings)] })
    const invocation = adapter.invocation(sandboxedLaunch())
    expect('args' in invocation && invocation.args).toEqual(expect.arrayContaining(['--settings', expect.stringContaining(`"prepush":["${GATE}"]`)]))
  })
})
