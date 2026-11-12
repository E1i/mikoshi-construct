import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { LORE, PLAIN_LORE } from '../../src/ui/lore.js'
import { OWNER_COMMAND_LINES } from './lore-owner-command-lines.js'

const EXPECTED_FILE = path.join(import.meta.dirname, 'lore-owner-command-lines.json')

type Expected = Readonly<Record<string, { lore: string, plain: string }>>

const expected = JSON.parse(readFileSync(EXPECTED_FILE, 'utf8')) as Expected

describe('the lore lines that take their command from the owner of owner commands', () => {
  it('keeps one expectation for each rendered line and one rendered line for each expectation', () => {
    expect(Object.keys(expected).sort()).toEqual(Object.keys(OWNER_COMMAND_LINES).sort())
  })

  it.each(Object.entries(OWNER_COMMAND_LINES))('%s reads in both registers as it read before the commands moved', (name, render) => {
    expect({ lore: render(LORE), plain: render(PLAIN_LORE) }).toEqual(expected[name])
  })
})
