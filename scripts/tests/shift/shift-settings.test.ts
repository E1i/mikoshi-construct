import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runInit } from '../../../src/commands/init.js'
import { readManifest, readShiftGate } from '../../../src/manifest.js'
import { createUi, silentWriter } from '../../../src/ui/console.js'
import { resolveTheme } from '../../../src/ui/theme.js'
import { treeReportPath } from '../../core/places.js'
import { settingsFlag, shiftSettings } from '../../ports/shift-settings.js'

function editCovers(rule: string, file: string): boolean {
  const pattern = /^Edit\(\/(.+)\)$/.exec(rule)?.[1]
  if (pattern === undefined)
    return false
  return pattern.endsWith('/**') ? file.startsWith(pattern.slice(0, -2)) : file === pattern
}

describe('the settings a card session is started with in a repository after construct init --preset node-library', () => {
  let tree = ''

  beforeAll(async () => {
    tree = mkdtempSync(path.join(tmpdir(), 'construct-shift-settings-'))
    await runInit(createUi(resolveTheme({ plain: true }), silentWriter), { dir: tree, preset: 'node-library', name: 'shift-settings-fixture', yes: true, dryRun: false })
  })

  afterAll(() => rmSync(tree, { recursive: true, force: true }))

  it('keep the sandbox on with no way to start without it or to run a command outside it', () => {
    expect(shiftSettings(tree, readShiftGate(tree)).sandbox).toMatchObject({ enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false })
  })

  it('bus sessions may bind a local port and reach no new host', () => {
    expect(shiftSettings(tree, readShiftGate(tree)).sandbox.network).toEqual({ allowLocalBinding: true })
  })

  it('allow exactly the gate commands of the tree\'s construct config and edits inside the card tree, and no other rule', () => {
    const command = readManifest(tree)!.harness.command
    expect(shiftSettings(tree, readShiftGate(tree)).permissions).toEqual({ allow: [`Bash(${command})`, `Edit(/${tree}/**)`] })
  })

  it('cover the tree report and a file inside the tree, and nothing beside the tree', () => {
    const { allow } = shiftSettings(tree, readShiftGate(tree)).permissions
    const covered = (file: string): boolean => allow.some(rule => editCovers(rule, file))
    expect([treeReportPath(tree), path.join(tree, 'src', 'index.ts'), `${tree}-beside/x`, path.join(path.dirname(tree), 'canary')].map(covered)).toEqual([true, true, false, false])
  })

  it('allow an edit outside the tree only on a file the starter names', () => {
    const question = path.join(tmpdir(), 'answers', 'owner-question.md')
    expect(shiftSettings(tree, readShiftGate(tree), [question]).permissions.allow.at(-1)).toBe(`Edit(/${question})`)
  })

  it('travel as one --settings argument holding the settings as JSON, behind --setting-sources that leaves out the user settings', () => {
    const settings = shiftSettings(tree, readShiftGate(tree))
    const [sourcesFlag, sources, flag, json] = settingsFlag(settings)
    expect({ sourcesFlag, sources, flag, settings: JSON.parse(json!) }).toEqual({ sourcesFlag: '--setting-sources', sources: 'project,local', flag: '--settings', settings })
  })
})
