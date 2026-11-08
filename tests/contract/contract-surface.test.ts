import type { CommandSurface, Surface } from '../../scripts/contract/surface.js'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { headCommands, undeclared } from '../../scripts/contract/surface.js'
import { FAILED_EXIT } from '../../src/failure.js'
import { fixtureSurface } from './surface-fixture.js'

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
})
