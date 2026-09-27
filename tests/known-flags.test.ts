import type { ArgsDef } from 'citty'
import { describe, expect, it } from 'vitest'
import { typedSpellings, unknownFlags } from '../src/known-flags.js'

const ARGS: ArgsDef = {
  dir: { type: 'string', default: '.' },
  dryRun: { type: 'boolean', default: false },
  yes: { type: 'boolean', alias: 'y', default: false },
}

describe('unknownFlags', () => {
  it('names a parsed key that matches no declared flag, alias, kebab spelling or built-in', () => {
    expect(unknownFlags(ARGS, { '_': [], 'dir': '.', 'definitely-not-a-flag': true })).toEqual(['definitely-not-a-flag'])
  })

  it('accepts a declared flag under its own camelCase name', () => {
    expect(unknownFlags(ARGS, { _: [], dryRun: true })).toEqual([])
  })

  it('accepts the kebab-case spelling citty adds for a camelCase flag', () => {
    expect(unknownFlags(ARGS, { '_': [], 'dry-run': true, 'dryRun': true })).toEqual([])
  })

  it('accepts a declared alias', () => {
    expect(unknownFlags(ARGS, { _: [], y: true, yes: true })).toEqual([])
  })

  it('accepts the --no- negation of a declared boolean flag, spelled however it was declared', () => {
    expect(unknownFlags(ARGS, { '_': [], 'dry-run': false, 'dryRun': false })).toEqual([])
  })

  it('never treats the --no- negation of an undeclared flag as known', () => {
    expect(unknownFlags(ARGS, { '_': [], 'not-declared': false })).toEqual(['not-declared'])
  })

  it('accepts citty\'s own built-in keys', () => {
    expect(unknownFlags(ARGS, { _: ['positional'], help: true, h: true, version: true, v: true })).toEqual([])
  })
})

describe('typedSpellings', () => {
  it('names every unknown flag once, as it was typed, whatever spellings the parser added', () => {
    expect(typedSpellings(['first-unknown', 'firstUnknown', 'second-unknown', 'secondUnknown'], ['--dir', 'x', '--first-unknown', '--second-unknown=1'])).toEqual(['--first-unknown', '--second-unknown'])
  })

  it('names a negated unknown flag the way it was typed, not the name the parser stripped', () => {
    expect(typedSpellings(['such-thing', 'suchThing'], ['--no-such-thing'])).toEqual(['--no-such-thing'])
  })
})
