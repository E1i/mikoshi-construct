import type { Surface } from '../../scripts/contract/surface.js'
import { describe, expect, it } from 'vitest'
import { requiredChange, unbaselined } from '../../scripts/contract/semantic-diff.js'
import { fixtureSurface, reading } from './surface-fixture.js'

type Edit = (surface: Surface) => void

function changeFrom(editBase: Edit, editHead: Edit): ReturnType<typeof requiredChange> {
  const base = fixtureSurface()
  const head = fixtureSurface()
  editBase(base)
  editHead(head)
  return requiredChange(reading(base), head)
}

function headChange(edit: Edit): ReturnType<typeof requiredChange> {
  return changeFrom(() => {}, edit)
}

const BREAKING: [string, Edit, string][] = [
  ['a command removed', head => delete head.commands.init, 'commands.init removed'],
  ['an alias removed', head => delete head.commands.inspect, 'commands.inspect removed'],
  ['an alias retargeted', (head) => { head.commands.inspect = { aliasOf: 'init' } }, 'commands.inspect.aliasOf: doctor → init'],
  ['an alias turned into a command', (head) => { head.commands.inspect = { flags: {} } }, 'commands.inspect: alias of doctor → a command of its own'],
  ['a flag removed', (head) => { head.commands.doctor = { flags: { dir: { type: 'string' } } } }, 'commands.doctor.flags.json removed'],
  ['a flag renamed', (head) => { head.commands.doctor = { flags: { dir: { type: 'string' }, asJson: { type: 'boolean' } } } }, 'commands.doctor.flags.json removed'],
  ['a flag type changed', (head) => { head.commands.doctor = { flags: { dir: { type: 'boolean' }, json: { type: 'boolean' } } } }, 'commands.doctor.flags.dir.type: string → boolean'],
  ['a flag short alias changed', (head) => { head.commands.init = { flags: { yes: { type: 'boolean', alias: 'Y' } } } }, 'commands.init.flags.yes.alias: y → Y'],
  ['an exit state removed', head => delete head.exits.doctor.notOk, 'exits.doctor.notOk removed'],
  ['an exit code value changed', (head) => { head.exits.doctor.noManifest = 2 }, 'exits.doctor.noManifest: 1 → 2'],
  ['a JSON state removed', head => delete head.jsonKeys.doctor.noManifest, 'jsonKeys.doctor.noManifest removed'],
  ['a key path removed', (head) => { head.jsonKeys.doctor.ok.keys = ['schemaVersion'] }, 'jsonKeys.doctor.ok.keys: ok removed'],
  ['a format version changed', (head) => { head.formats.manifestVersion = 2 }, 'formats.manifestVersion: 1 → 2'],
  ['an init path removed', (head) => { head.paths.init['node-library'] = ['AGENTS.md'] }, 'paths.init.node-library: package.json removed'],
  ['an attach path removed', (head) => { head.paths.attach.writes = [] }, 'paths.attach.writes: AGENTS.md removed'],
  ['a block marker removed', (head) => { head.markers.block = [] }, 'markers.block: <!-- construct:begin --> … <!-- construct:end --> removed'],
  ['a discovery marker removed', (head) => { head.markers.discover.markers = [] }, 'markers.discover.markers: product removed'],
  ['a flag short alias removed', (head) => { head.commands.init = { flags: { yes: { type: 'boolean' } } } }, 'commands.init.flags.yes.alias: y removed'],
  ['an item moved out of the contract into outside', (head) => { head.outside = ['lore strings', 'soulkill --json'] }, 'outside: soulkill --json added, so it leaves the contract'],
]

const ADDITIVE: [string, Edit, string][] = [
  ['a command added', (head) => { head.commands.graph = { flags: {} } }, 'commands.graph added'],
  ['a flag added', (head) => { head.commands.init = { flags: { yes: { type: 'boolean', alias: 'y' }, plain: { type: 'boolean' } } } }, 'commands.init.flags.plain added'],
  ['an exit state added', (head) => { head.exits.doctor.ahead = 1 }, 'exits.doctor.ahead added'],
  ['a JSON state added', (head) => { head.jsonKeys.doctor.notOk = { root: 'object', keys: ['schemaVersion'] } }, 'jsonKeys.doctor.notOk added'],
  ['a key path added', (head) => { head.jsonKeys.doctor.noManifest.keys = ['root', 'schemaVersion'] }, 'jsonKeys.doctor.noManifest.keys: root added'],
  ['a path added', (head) => { head.paths.init['node-library'] = ['AGENTS.md', 'README.md', 'package.json'] }, 'paths.init.node-library: README.md added'],
  ['a discovery marker added', (head) => { head.markers.discover.markers = ['product', 'module-map'] }, 'markers.discover.markers: module-map added'],
  ['a short alias given to a flag that had none', (head) => { head.commands.init = { flags: { yes: { type: 'boolean', alias: 'y' }, dir: { type: 'string', alias: 'd' } } } }, 'commands.init.flags.dir added'],
  ['an item taken out of outside, which brings it into the contract', (head) => { head.outside = [] }, 'outside: lore strings removed, so it enters the contract'],
]

describe('requiredChange classifies the difference between two surfaces', () => {
  it('identical surfaces require none', () => {
    expect(headChange(() => {})).toEqual({ level: 'none', reasons: [] })
  })

  it.each(BREAKING)('%s is breaking', (_, edit, reason) => {
    const change = headChange(edit)
    expect(change.level).toBe('breaking')
    expect(change.reasons).toContain(reason)
  })

  it.each(ADDITIVE)('%s is additive', (_, edit, reason) => {
    expect(headChange(edit)).toEqual({ level: 'additive', reasons: [reason] })
  })

  it('a short alias added to an existing flag is additive', () => {
    const change = changeFrom(
      (base) => { base.commands.init = { flags: { yes: { type: 'boolean' } } } },
      (head) => { head.commands.init = { flags: { yes: { type: 'boolean', alias: 'y' } } } },
    )
    expect(change).toEqual({ level: 'additive', reasons: ['commands.init.flags.yes.alias: y added'] })
  })

  it('an exit code value change is breaking', () => {
    const exitOkBecomesThree: Edit = (head) => {
      head.exits.doctor.ok = 3
    }
    expect(headChange(exitOkBecomesThree)).toEqual({ level: 'breaking', reasons: ['exits.doctor.ok: 0 → 3'] })
  })

  it('root null → object in one state is breaking, with its keys unchanged', () => {
    const change = changeFrom(
      (base) => { base.jsonKeys.doctor.noManifest.root = 'null' },
      (head) => { head.jsonKeys.doctor.noManifest.root = 'object' },
    )
    expect(change).toEqual({ level: 'breaking', reasons: ['jsonKeys.doctor.noManifest.root: null → object'] })
  })

  it('a root change is breaking even when keys are only added in that state', () => {
    const change = changeFrom(
      (base) => { base.jsonKeys.doctor.ok.root = 'array' },
      (head) => { head.jsonKeys.doctor.ok.keys = ['extra', 'ok', 'schemaVersion'] },
    )
    expect(change.level).toBe('breaking')
    expect(change.reasons).toContain('jsonKeys.doctor.ok.root: array → object')
  })

  it('a section unbaselined in the base is breaking, and the reason names the section', () => {
    const base = reading(fixtureSurface())
    const change = requiredChange({ ...base, exits: unbaselined('exit codes are not observable') }, fixtureSurface())
    expect(change.level).toBe('breaking')
    expect(change.reasons).toEqual([expect.stringMatching(/^exits: unbaselined in the base \(exit codes are not observable\)/)])
  })

  it('a JSON pair unbaselined in the base is breaking, and the reason names its command, state and why', () => {
    const base = reading(fixtureSurface())
    const head = fixtureSurface()
    const change = requiredChange({ ...base, jsonKeys: { doctor: { ...head.jsonKeys.doctor, ok: unbaselined('doctor ok printed no JSON') } } }, head)
    expect(change).toEqual({ level: 'breaking', reasons: ['jsonKeys.doctor.ok: unbaselined in the base (doctor ok printed no JSON), so it counts as changed'] })
  })

  it('beside an unbaselined pair, every other pair is diffed on its own result', () => {
    const base = reading(fixtureSurface())
    const head = fixtureSurface()
    const change = requiredChange({ ...base, jsonKeys: { doctor: { ok: unbaselined('doctor ok printed no JSON'), noManifest: { root: 'null', keys: [] } } } }, head)
    expect(change.level).toBe('breaking')
    expect(change.reasons).toEqual([
      'jsonKeys.doctor.ok: unbaselined in the base (doctor ok printed no JSON), so it counts as changed',
      'jsonKeys.doctor.noManifest.root: null → object',
      'jsonKeys.doctor.noManifest.keys: schemaVersion added',
    ])
  })
})
