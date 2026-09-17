import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { LEVELS } from '../src/commands/doctor/verdict.js'
import { render } from '../src/materialize/templates.js'

describe('render', () => {
  it('substitutes variables and throws on an unknown one', () => {
    expect(render('{{a}}-{{ b }}', { a: '1', b: '2' })).toBe('1-2')
    expect(() => render('{{missing}}', {})).toThrow('template variable "missing"')
  })

  it('keeps or drops whole-line conditional blocks by the truthiness of a variable', () => {
    const template = 'head\n{{#if flag}}\nyes {{name}}\n{{/if}}\n{{#unless flag}}\nno\n{{/unless}}\ntail\n'
    expect(render(template, { flag: 'true', name: 'x' })).toBe('head\nyes x\ntail\n')
    expect(render(template, { flag: '', name: 'x' })).toBe('head\nno\ntail\n')
    expect(render(template, { flag: 'false', name: 'x' })).toBe('head\nno\ntail\n')
    expect(() => render('{{#if nope}}\n\n{{/if}}\n', {})).toThrow('template variable "nope"')
  })
})

const DECISIONS_README = path.join(import.meta.dirname, '../templates/base/architecture/decisions/README.md')

describe('the decision record template', () => {
  it('explains every enforcement level a doctor check can report', () => {
    const readme = readFileSync(DECISIONS_README, 'utf8')
    for (const level of LEVELS)
      expect(readme, level).toContain(`| ${level} |`)
  })
})
