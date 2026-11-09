import type { CommandSurface, Surface } from '../../scripts/contract/surface.js'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { requiredChange } from '../../scripts/contract/semantic-diff.js'
import { headCommands, refusalCode, undeclared, unknownFlagRefusals } from '../../scripts/contract/surface.js'
import { FAILED_EXIT } from '../../src/failure.js'
import { fixtureSurface, reading } from './surface-fixture.js'

const RECORDED = path.resolve(import.meta.dirname, '../../contract/surface.json')

function recorded(): Surface {
  return JSON.parse(readFileSync(RECORDED, 'utf8')) as Surface
}

function headWith(command: string, flag: string, type: string): Record<string, CommandSurface> {
  const head = fixtureSurface().commands
  const own = head[command]
  if (!('flags' in own))
    throw new Error(`${command} is an alias in the fixture`)
  return { ...head, [command]: { flags: { ...own.flags, [flag]: { type } } } }
}

describe('contract/surface.json declares every flag, json form and unknown-flag refusal the command line has', () => {
  it('leaves nothing the head command line accepts undeclared', () => {
    expect(undeclared(recorded(), headCommands())).toEqual([])
  })

  it('records for every command that an unknown flag is refused with the failed exit', () => {
    const surface = recorded()
    const commands = Object.entries(surface.commands).filter(([, command]) => 'flags' in command).map(([name]) => name).sort()
    expect(Object.keys(surface.unknownFlag).sort()).toEqual(commands)
    expect(Object.entries(surface.unknownFlag).filter(([, code]) => code !== FAILED_EXIT)).toEqual([])
  })

  it('declares the doctor --factory and cost --expect json forms', () => {
    const surface = recorded()
    expect(surface.jsonForms['doctor --factory']).toContain('--factory')
    expect(surface.jsonForms['cost --expect']).toContain('--expect')
    expect(Object.keys(surface.jsonKeys['doctor --factory'] ?? {})).not.toEqual([])
    expect(Object.keys(surface.jsonKeys['cost --expect'] ?? {})).not.toEqual([])
  })

  it('records a schemaVersion on every json form, cost --expect included', () => {
    const surface = recorded()
    const states = Object.entries(surface.jsonKeys).flatMap(([form, byState]) => Object.entries(byState).map(([state, sample]) => ({ form, state, sample })))
    expect(states.filter(({ sample }) => sample.root === 'object' && !sample.keys.includes('schemaVersion')).map(({ form, state }) => `${form} ${state}`)).toEqual([])
    expect(surface.jsonKeys['cost --expect']?.forecast?.keys).toContain('schemaVersion')
  })

  it('a flag or json form a command accepts that contract/surface.json does not declare fails the check', () => {
    const surface = recorded()
    const head = headCommands()
    const doctor = head.doctor
    if (!('flags' in doctor))
      throw new Error('doctor is an alias on the command line')
    const withFlag = { ...head, doctor: { flags: { ...doctor.flags, undeclaredMode: { type: 'boolean' } } } }
    expect(undeclared(surface, head)).toEqual([])
    expect(undeclared(surface, withFlag)).toEqual([
      'doctor --undeclared-mode: the flag is not declared as boolean',
      'doctor --undeclared-mode --json: the json form is not declared',
    ])
    expect(undeclared({ ...surface, commands: withFlag }, withFlag)).toEqual(['doctor --undeclared-mode --json: the json form is not declared'])
  })

  it('fails on a flag the command accepts and the contract does not declare', () => {
    expect(undeclared(fixtureSurface(), headWith('init', 'force', 'boolean'))).toEqual(['init --force: the flag is not declared as boolean'])
  })

  it('fails on a flag whose declared type differs from the one the command accepts', () => {
    expect(undeclared(fixtureSurface(), headWith('init', 'yes', 'string'))).toEqual(['init --yes: the flag is not declared as string'])
  })

  it('fails on a json form the command accepts and the contract does not declare', () => {
    const surface = fixtureSurface()
    const head = headWith('doctor', 'fullReport', 'boolean')
    expect(undeclared({ ...surface, commands: head }, head)).toEqual(['doctor --full-report --json: the json form is not declared'])
  })

  it('accepts a json form once a sample passes its flag', () => {
    const surface = fixtureSurface()
    const head = headWith('doctor', 'fullReport', 'boolean')
    const forms = { ...surface.jsonForms, 'doctor --full-report': ['--full-report', '--json'] }
    const keys = { ...surface.jsonKeys, 'doctor --full-report': { ok: { root: 'object' as const, keys: ['schemaVersion'] } } }
    expect(undeclared({ ...surface, commands: head, jsonForms: forms, jsonKeys: keys }, head)).toEqual([])
  })

  it('fails on a declared json form with no recorded shape', () => {
    const surface = fixtureSurface()
    expect(undeclared({ ...surface, jsonForms: { ...surface.jsonForms, 'doctor --quiet': ['--json', '--quiet'] } }, surface.commands)).toEqual(['doctor --quiet: the json form has no recorded shape'])
  })

  it('fails on a command and an alias the contract does not declare', () => {
    const surface = fixtureSurface()
    const head = { ...surface.commands, atlas: { flags: {} }, check: { aliasOf: 'doctor' } }
    expect(undeclared(surface, head)).toEqual([
      'check: the alias is not declared',
      'atlas: the command is not declared',
      'atlas: the exit codes are not declared',
      'atlas --undeclared-flag-probe: the refusal of an unknown flag is not declared as exit 1',
    ])
  })

  it('fails on a command whose exit codes are not declared', () => {
    const surface = fixtureSurface()
    const { init: _, ...exits } = surface.exits
    expect(undeclared({ ...surface, exits }, surface.commands)).toEqual(['init: the exit codes are not declared'])
  })

  it('declares the exit codes of atlas and say, which have no json form', () => {
    const surface = recorded()
    expect(surface.exits.atlas).toEqual({ written: 0, failed: FAILED_EXIT })
    expect(surface.exits.say).toEqual({ said: 0, noWords: 2, failed: FAILED_EXIT })
    const head = headCommands()
    const takesJson = (name: string): boolean => {
      const command = head[name]
      return !('flags' in command) || 'json' in command.flags
    }
    expect(['atlas', 'say'].filter(takesJson)).toEqual([])
  })

  it('fails on a command whose refusal of an unknown flag is not recorded as the failed exit', () => {
    const surface = fixtureSurface()
    expect(undeclared({ ...surface, unknownFlag: { ...surface.unknownFlag, init: 0 } }, surface.commands)).toEqual(['init --undeclared-flag-probe: the refusal of an unknown flag is not declared as exit 1'])
  })

  it('a probe that never exits is a failure of the generator, not a recorded refusal', () => {
    expect(() => refusalCode('doctor', null)).toThrow('doctor --undeclared-flag-probe did not exit within 60000 ms')
    expect(refusalCode('doctor', 1)).toBe(1)
    expect(refusalCode('doctor', 0)).toBe(0)
  })

  it('probes every command but an alias with the unknown flag last, and records the code it exits with', () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), 'construct-probe-')))
    try {
      mkdirSync(path.join(root, 'node_modules/tsx/dist'), { recursive: true })
      writeFileSync(path.join(root, 'node_modules/tsx/dist/cli.mjs'), 'const args = process.argv.slice(3)\nprocess.exit(args.at(-1) === \'--undeclared-flag-probe\' ? args.length : 0)\n')
      const commands: Record<string, CommandSurface> = { 'doctor': { flags: {} }, 'inspect': { aliasOf: 'doctor' }, 'mutate apply': { flags: {} } }
      expect(unknownFlagRefusals({ root, holdsHeadInvariants: false }, commands)).toEqual({ 'doctor': 2, 'mutate apply': 3 })
    }
    finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('a json form or unknown-flag refusal removed is breaking, one added is additive', () => {
    const base = reading(fixtureSurface())
    expect(requiredChange(base, { ...base, jsonForms: {} })).toEqual({ level: 'breaking', reasons: ['jsonForms.doctor removed'] })
    expect(requiredChange(base, { ...base, jsonForms: { doctor: ['--json', '--quiet'] } })).toEqual({ level: 'additive', reasons: ['jsonForms.doctor: --quiet added'] })
    expect(requiredChange(base, { ...base, unknownFlag: { doctor: 0, init: 1 } })).toEqual({ level: 'breaking', reasons: ['unknownFlag.doctor: 1 → 0'] })
    expect(requiredChange(base, { ...base, unknownFlag: { doctor: 1, init: 1, sync: 1 } })).toEqual({ level: 'additive', reasons: ['unknownFlag.sync added'] })
  })

  it('a base recorded before json forms and unknown-flag refusals were declared reads them as empty, so declaring them is additive', () => {
    const head = reading(fixtureSurface())
    const { jsonForms: _, unknownFlag: __, ...older } = head
    expect(requiredChange(older as typeof head, head)).toEqual({ level: 'additive', reasons: ['jsonForms.doctor added', 'unknownFlag.doctor added', 'unknownFlag.init added'] })
  })
})
