import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { PRESET_LIST } from '../src/presets/index.js'
import { PLAIN_LORE } from '../src/ui/lore.js'
import { createClackPrompter, fromAiTarget, isValidProjectName, toAiTarget } from '../src/ui/prompts.js'

function terminal() {
  const input = new PassThrough()
  const output = new PassThrough()
  let rendered = ''
  output.setEncoding('utf8')
  output.on('data', (chunk: string) => {
    rendered += chunk
  })
  const prompter = createClackPrompter(PLAIN_LORE, { input, output })
  const press = (keys: string): void => {
    setTimeout(() => input.write(keys), 10)
  }
  return { prompter, press, rendered: () => rendered }
}

const ENTER = '\r'
const CTRL_C = '\x03'
const DOWN = '\x1B[B'
const SPACE = ' '

describe('ai target mapping', () => {
  it('folds the multiselect answer into an AiTarget and back', () => {
    expect(toAiTarget(['claude'])).toBe('claude')
    expect(toAiTarget(['cursor'])).toBe('cursor')
    expect(toAiTarget(['cursor', 'claude'])).toBe('both')
    expect(fromAiTarget('both')).toEqual(['claude', 'cursor'])
    expect(fromAiTarget('cursor')).toEqual(['cursor'])
  })
})

describe('project name validation', () => {
  it('accepts npm-style names and rejects the rest', () => {
    expect(isValidProjectName('my-api')).toBe(true)
    expect(isValidProjectName('shop.v2_core')).toBe(true)
    expect(isValidProjectName('My Api')).toBe(false)
    expect(isValidProjectName('-lead')).toBe(false)
    expect(isValidProjectName('')).toBe(false)
  })
})

describe('clack prompter', () => {
  it('confirms on Enter and reports a cancel as undefined', async () => {
    const yes = terminal()
    yes.press(ENTER)
    expect(await yes.prompter.confirm('Write?')).toBe(true)

    const bail = terminal()
    bail.press(CTRL_C)
    expect(await bail.prompter.confirm('Write?')).toBeUndefined()
    expect(bail.rendered()).toContain(PLAIN_LORE.cancelled)
  })

  it('selects the suggested preset by default and lists every preset', async () => {
    const t = terminal()
    t.press(ENTER)
    expect(await t.prompter.preset(PRESET_LIST, 'node-backend')).toBe('node-backend')
    for (const preset of PRESET_LIST)
      expect(t.rendered()).toContain(preset.label)
  })

  it('turns a multiselect into an AI target', async () => {
    const t = terminal()
    t.press(`${DOWN}${SPACE}${ENTER}`)
    expect(await t.prompter.aiTarget('claude')).toBe('both')
  })

  it('returns the edited project name', async () => {
    const t = terminal()
    t.press(`-v2${ENTER}`)
    expect(await t.prompter.projectName('demo')).toBe('demo-v2')
  })
})
