import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { HANDOFF_FIELDS, missingFields, runHandoffCheck } from '../../ghosts/handoff-check.js'

function completeHandoff(except: string[] = []): string {
  return HANDOFF_FIELDS.filter(field => !except.includes(field.id)).map(field => `${field.label}: ${field.id} value`).join('\n')
}

function check(file: string | undefined, text: string | null): { code: number, out: string[], err: string[] } {
  const out: string[] = []
  const err: string[] = []
  const code = runHandoffCheck(file === undefined ? [] : [file], { exists: () => text !== null, read: () => text ?? '', out: line => out.push(line), err: line => err.push(line) })
  return { code, out, err }
}

describe('handoff-check', () => {
  it('passes a complete handoff', () => {
    expect(missingFields(completeHandoff())).toEqual([])
    expect(check('h.md', completeHandoff()).code).toBe(0)
  })

  it.each(HANDOFF_FIELDS.map(field => [field.id, field] as const))('refuses a handoff that lacks a mandatory field: %s', (id, field) => {
    expect(missingFields(completeHandoff([id])).map(missing => missing.id)).toEqual([id])
    const result = check('h.md', completeHandoff([id]))
    expect(result.code).toBe(1)
    expect(result.err.join('\n')).toContain(`missing: ${field.label} (${id}`)
  })

  it.each(HANDOFF_FIELDS.map(field => [field.id, field] as const))('refuses a handoff whose field is empty: %s', (id, field) => {
    const emptied = completeHandoff([id]).concat(`\n${field.label}:   \n`)
    expect(missingFields(emptied).map(missing => missing.id)).toEqual([id])
  })

  it('reads a field under a heading as its body', () => {
    const text = `${completeHandoff(['done', 'queue'])}\n## Done\n- one thing\n## Queue\n\n`
    expect(missingFields(text).map(missing => missing.id)).toEqual(['queue'])
  })

  it('reads a bulleted and case-varied label', () => {
    expect(missingFields(`${completeHandoff(['stop-reason'])}\n- Stop Reason: eddies warn`)).toEqual([])
  })

  it('reads a numbered label, a heading that ends in a colon and CRLF line endings', () => {
    expect(missingFields(`${completeHandoff(['stop-reason'])}\n1. stop reason: eddies warn`)).toEqual([])
    expect(missingFields(`${completeHandoff(['stop-reason'])}\n- 1. stop reason: eddies warn`)).toEqual([])
    expect(missingFields(`${completeHandoff(['done']).replaceAll('\n', '\r\n')}\r\n## Done:\r\none thing\r\n`)).toEqual([])
  })

  it('refuses a value that is only a placeholder dash and accepts none as an answer', () => {
    expect(missingFields(`${completeHandoff(['cloud-runs'])}\ncloud runs: —`).map(missing => missing.id)).toEqual(['cloud-runs'])
    expect(missingFields(`${completeHandoff(['cloud-runs'])}\ncloud runs: -`).map(missing => missing.id)).toEqual(['cloud-runs'])
    for (const placeholder of ['~', '<>', 'TBD', 'todo'])
      expect(missingFields(`${completeHandoff(['cloud-runs'])}\ncloud runs: ${placeholder}`).map(missing => missing.id)).toEqual(['cloud-runs'])
    expect(missingFields(`${completeHandoff(['cloud-runs'])}\ncloud runs: none`)).toEqual([])
    expect(missingFields(`${completeHandoff(['cloud-runs'])}\ncloud runs: n/a`)).toEqual([])
  })

  it('names every missing field at once and exits 1 on an absent file', () => {
    expect(check('h.md', '').err.filter(line => line.includes('missing:'))).toHaveLength(HANDOFF_FIELDS.length)
    expect(check('h.md', null).code).toBe(1)
    expect(check(undefined, null).code).toBe(2)
  })

  it('keeps ids and labels unique', () => {
    expect(new Set(HANDOFF_FIELDS.map(field => field.id)).size).toBe(HANDOFF_FIELDS.length)
    expect(new Set(HANDOFF_FIELDS.map(field => field.label)).size).toBe(HANDOFF_FIELDS.length)
  })

  it('is named by window.md at the boundary, which points here and holds no copy of the list', () => {
    const doc = readFileSync(path.join(import.meta.dirname, '../../../architecture/window.md'), 'utf8')
    expect(doc).toContain('pnpm handoff:check')
    expect(doc).toContain('scripts/ghosts/handoff-check.ts')
    for (const field of HANDOFF_FIELDS.filter(field => field.label.includes(' ')))
      expect(doc).not.toContain(`${field.label}:`)
  })
})
