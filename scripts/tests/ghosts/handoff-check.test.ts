import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { HANDOFF_FIELDS, HANDOFF_LIMIT, handoffRefusals, missingFields, parkedDepends, RETIRED_PARKING, runHandoffCheck } from '../../ghosts/handoff-check.js'

function completeHandoff(except: string[] = []): string {
  return HANDOFF_FIELDS.filter(field => !except.includes(field.id)).map(field => `${field.label}: ${field.id} value`).join('\n')
}

const PARKED = new Map<number, number[]>([[650, []], [652, [650]], [681, []]])

function check(file: string | undefined, text: string | null): { code: number, out: string[], err: string[] } {
  const out: string[] = []
  const err: string[] = []
  const code = runHandoffCheck(file === undefined ? [] : [file], { exists: () => text !== null, read: () => text ?? '', parked: () => PARKED, home: '/home/x', out: line => out.push(line), err: line => err.push(line) })
  return { code, out, err }
}

function handoff(fields: Record<string, string> = {}, sections = 1): string {
  const values: Record<string, string> = { ...Object.fromEntries(HANDOFF_FIELDS.map(field => [field.label, `${field.id} value`])), 'queue': '#650 → #652 → #681', 'prev': 'none', 'in-flight': '#681 review PR #625', ...fields }
  const section = Object.entries(values).map(([label, value]) => `${label}: ${value}`).join('\n')
  return [`# Handoff`, ...Array.from({ length: sections }, (_, index) => `## STOP — window ${index + 1}\n${section}\n\nSTATUS: CONTINUE`)].join('\n\n')
}

function refusals(text: string, exists: (file: string) => boolean = () => false): string[] {
  return handoffRefusals(text, { file: '/h/handoff.md', exists, parked: PARKED })
}

describe('handoff-check', () => {
  it('passes a complete handoff', () => {
    expect(missingFields(completeHandoff())).toEqual([])
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
    expect(check('h.md', '').err.filter(line => line.includes('missing:'))).toHaveLength(HANDOFF_FIELDS.length + 2)
    expect(check('h.md', null).code).toBe(1)
    expect(check(undefined, null).code).toBe(2)
  })

  it('passes a bounded handoff with one STOP section', () => {
    expect(refusals(handoff())).toEqual([])
    expect(check('h.md', handoff()).code).toBe(0)
  })

  it('refuses a handoff with two STOP sections', () => {
    expect(refusals(handoff({}, 2))).toContain('[handoff:check] STOP sections: 2; a handoff holds exactly one, the older ones go to the archive through pnpm handoff:write')
    expect(check('h.md', handoff({}, 2)).code).toBe(1)
    expect(refusals(handoff({}, 2).replace(/^## STOP.*$/gm, '## Notes'))).toContainEqual(expect.stringContaining('STOP sections: 0'))
  })

  it('refuses a handoff over the size limit and names the bloated field', () => {
    const bloated = handoff({ 'not done': 'x'.repeat(HANDOFF_LIMIT) })
    expect(refusals(bloated)).toEqual([`[handoff:check] too large: ${bloated.length} chars over the limit of ${HANDOFF_LIMIT}; largest field: not done (${'not done'.length + HANDOFF_LIMIT} chars)`])
    expect(refusals(handoff({ 'not done': 'x'.repeat(HANDOFF_LIMIT - handoff().length - 200) }))).toEqual([])
  })

  it('refuses prose in queue', () => {
    expect(refusals(handoff({ queue: '#650 body → #652 (owner A/B)' }))).toEqual(['[handoff:check] queue: prose "body (owner A/B)"; queue takes only card numbers (#N), and their order comes from the cards\' depends in parking'])
    expect(refusals(handoff({ queue: '#650, #652 -> #681 ∥ #650 · #681' }))).toEqual([])
    expect(refusals(handoff({ queue: 'none' }))).toEqual([])
    expect(refusals(handoff({ queue: '#650 none' }))[0]).toContain('queue: prose "none"')
  })

  it('refuses a queue that puts a card before the card it depends on, or names an unparked card', () => {
    expect(refusals(handoff({ queue: '#652 → #650' }))).toEqual(['[handoff:check] queue: #652 depends on #650, which comes after it'])
    expect(refusals(handoff({ queue: '#650 #999' }))).toEqual(['[handoff:check] queue: #999 is not a parked card'])
  })

  it('refuses a second queue, in-flight or prev line that would carry what the first one may not', () => {
    const text = handoff().replace('STATUS: CONTINUE', 'queue: after #650 lands ask the owner\nin-flight: rewriting everything\nSTATUS: CONTINUE')
    expect(refusals(text)).toEqual(expect.arrayContaining(['[handoff:check] queue: appears 2 times; a handoff holds one', '[handoff:check] in-flight: appears 2 times; a handoff holds one']))
  })

  it('names an unknown bloated label rather than the field before it', () => {
    const bloated = `${handoff()}\nnotes: ${'x'.repeat(HANDOFF_LIMIT)}`
    expect(refusals(bloated)[0]).toContain(`largest field: notes (${'notes'.length + HANDOFF_LIMIT} chars)`)
  })

  it('takes prev: none or an archive that exists beside the handoff', () => {
    expect(refusals(handoff({ prev: 'handoff.md' }), () => true)).toEqual(['[handoff:check] prev: handoff.md is not archive/NNNN.md beside the handoff'])
    expect(refusals(handoff({ prev: '../h/archive/0001.md' }), () => true)[0]).toContain('is not archive/NNNN.md')
    expect(refusals(handoff({ prev: 'archive/0001.md' }), file => file === '/h/archive/0001.md')).toEqual([])
    expect(refusals(handoff({ prev: 'archive/0002.md' }))).toEqual(['[handoff:check] prev: archive/0002.md does not exist'])
    expect(refusals(handoff({ prev: '' }))[0]).toContain('missing: prev')
  })

  it('takes in-flight as one line per card in the form #N <stage> [PR #M]', () => {
    expect(refusals(handoff({ 'in-flight': '\n- #681 review PR #625\n- #677 brief\n#678 ci PR#630' }))).toEqual([])
    expect(refusals(handoff({ 'in-flight': 'none' }))).toEqual([])
    expect(refusals(handoff({ 'in-flight': '#681 waits for the cloud review' }))).toEqual(['[handoff:check] in-flight: "#681 waits for the cloud review" is not #N <stage> [PR #M]'])
    expect(refusals(handoff({ 'in-flight': '' }))[0]).toContain('missing: in-flight')
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

describe('parkedDepends', () => {
  it('reads the parking root and its live subdirectories, never the retired ones', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'parked-'))
    const card = (id: number, depends: string): string => `card: #${id} c${id} [implement/ghosts/S/cheap/auto] · depends ${depends} · blocks —\nbranch: feat/c${id}\ntouches: scripts/x.ts\ncontinue: stop\nwho: window\n\nbody\n`
    for (const dir of ['autonomy', 'autonomy/deeper', ...RETIRED_PARKING])
      mkdirSync(path.join(root, dir), { recursive: true })
    writeFileSync(path.join(root, '1.md'), card(1, '—'))
    writeFileSync(path.join(root, 'autonomy', '2.md'), card(2, '#1'))
    writeFileSync(path.join(root, 'autonomy', 'deeper', '3.md'), card(3, '—'))
    RETIRED_PARKING.forEach((dir, index) => writeFileSync(path.join(root, dir, `${10 + index}.md`), card(10 + index, '—')))
    expect([...parkedDepends(root)].sort()).toEqual([[1, []], [2, [1]]])
    rmSync(root, { recursive: true, force: true })
  })
})
