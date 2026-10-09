import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { LADDER_REASON, STOP_AT } from '../../shift/parking.js'
import { USAGE } from '../../shift/shift.js'

const root = path.resolve(import.meta.dirname, '../../..')
const windowDoc = readFileSync(path.join(root, 'architecture/window.md'), 'utf8')
const contributing = readFileSync(path.join(root, 'CONTRIBUTING.md'), 'utf8')
const shiftRow = contributing.split('\n').find(line => line.startsWith('| `pnpm shift` |')) ?? ''

describe('the documents say what the autopilot does', () => {
  it('the usage of pnpm shift names --manual and the autopilot line', () => {
    expect(USAGE).toContain('--manual')
    expect(USAGE).toContain('event:autopilot')
    expect(USAGE).toContain('event:stop')
  })

  it('the pnpm shift row of CONTRIBUTING.md carries --manual in its flags and says what it does', () => {
    expect(shiftRow).toContain('[--queue] [--manual]`')
    expect(shiftRow).toContain('`--manual` turns the automation off for that run')
  })

  it('window.md explains the stop event, every place it can stand, waits and the autopilot line', () => {
    expect(windowDoc).toContain('"event":"stop"')
    expect(windowDoc).toContain('"event":"autopilot"')
    expect(windowDoc).toContain('`waits <at>`')
    for (const at of STOP_AT)
      expect(windowDoc).toContain(`\`${at}\``)
  })
})

describe('the documents say the shift runs a ladder card', () => {
  it('the usage, CONTRIBUTING.md and window.md name the steps and the approvers of the ladder route', () => {
    expect(USAGE.split('\n')[0]).toBe('usage: pnpm shift <dir> [--parking <parking>] [--check] [--queue]')
    expect(USAGE).toContain('ghosts:hash --by morse')
    expect(USAGE).toContain('ghosts:launch')
    expect(shiftRow).toContain('a ladder card with `who: shift` is taken')
    expect(shiftRow).not.toContain('never taken')
    expect(windowDoc).toContain('`pnpm ghosts:launch --tasks')
    expect(windowDoc).toContain('--by morse --card <id>')
    expect(windowDoc).not.toContain('which the shift never takes')
    expect(windowDoc).toContain('an `.approved-sha256` file alone never counts')
  })

  it('the LADDER_REASON on a hash stop names both approvers', () => {
    expect(LADDER_REASON).toContain('MORSE')
    expect(LADDER_REASON).not.toContain('R2–R4')
    expect(LADDER_REASON).toContain('owner')
    expect(LADDER_REASON).not.toContain('R1')
  })
})
