import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const SCRIPT = path.resolve(import.meta.dirname, '..', 'scripts/construct/check-acceptance.mjs')

interface CheckAcceptance {
  normalizeItem: (item: string) => string
  agreedItems: (text: string) => string[] | null
  argsAcceptance: (json: string) => string[]
  missingItems: (agreed: string[], acceptance: string[]) => string[]
}

const { agreedItems, argsAcceptance, missingItems, normalizeItem } = await import(pathToFileURL(SCRIPT).href) as CheckAcceptance

const AGREED = [
  '/implement Acceptance echo in the ladder:',
  'the ladder echoes what it received.',
  'Acceptance: a ladder-run test shows `acceptance` equal to the args; the template copy is byte-identical;',
  '  minor changeset starting `templates:`.',
  'Mutations: M1 | the echo only in `done` | red: the failed test',
].join('\n')

const ITEMS = [
  'a ladder-run test shows `acceptance` equal to the args',
  'the template copy is byte-identical',
  'minor changeset starting `templates:`',
]

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

function runCheck(agreed: string, args: string): { status: number | null, stdout: string, stderr: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'check-acceptance-'))
  dirs.push(dir)
  writeFileSync(path.join(dir, 'agreed.txt'), agreed)
  writeFileSync(path.join(dir, 'args.json'), args)
  const child = spawnSync(process.execPath, [SCRIPT, '--agreed', path.join(dir, 'agreed.txt'), '--args', path.join(dir, 'args.json')], { encoding: 'utf8' })
  return { status: child.status, stdout: child.stdout, stderr: child.stderr }
}

describe('the agreed Acceptance section', () => {
  it('runs from the label to Mutations, split on semicolons, trimmed of a trailing period', () => {
    expect(agreedItems(AGREED)).toEqual(ITEMS)
  })

  it('runs to the end of the text when no Mutations follow', () => {
    expect(agreedItems('Task. Acceptance: one; two.')).toEqual(['one', 'two'])
  })

  it('ends at a sentence starting Mutations on the same line', () => {
    expect(agreedItems('Acceptance: one; two. Mutations: M1 | x | red')).toEqual(['one', 'two'])
  })

  it('is absent when the label is', () => {
    expect(agreedItems('/implement add a rule')).toBeNull()
  })
})

describe('matching agreed items against args.acceptance', () => {
  it('normalises both sides the same way', () => {
    expect(normalizeItem('  a   b\n c. ')).toBe('a b c')
    expect(missingItems(['a b c'], ['a  b c.'])).toEqual([])
  })

  it('does not count an item as present when it is only a substring of an element', () => {
    expect(missingItems(['the harness'], ['the harness is green'])).toEqual(['the harness'])
  })

  it('reads a missing args.acceptance as empty and refuses one that is not an array of strings', () => {
    expect(argsAcceptance('{"task":"t"}')).toEqual([])
    expect(() => argsAcceptance('{"acceptance":[1]}')).toThrow('not an array of strings')
  })
})

describe('the check the skill runs before the Workflow call', () => {
  it('stops when an agreed item dropped out before the call', () => {
    const result = runCheck(AGREED, JSON.stringify({ task: 't', acceptance: [ITEMS[0], ITEMS[2]] }))

    expect(result.status).toBe(1)
    expect(result.stderr.split('\n').filter(Boolean)).toEqual([ITEMS[1]])
  })

  it('passes when every agreed item is in the args verbatim', () => {
    const result = runCheck(AGREED, JSON.stringify({ task: 't', acceptance: [...ITEMS, 'an item the skill added'] }))

    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
  })

  it('passes and says so when the agreed line has no Acceptance section', () => {
    const result = runCheck('/implement add a rule', JSON.stringify({ task: 't', acceptance: ['anything'] }))

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('nothing was agreed to check')
  })

  it('exits 2 with the reason on malformed args JSON', () => {
    const result = runCheck(AGREED, '{"acceptance": [')

    expect(result.status).toBe(2)
    expect(result.stderr).toContain('not valid JSON')
  })

  it('exits 2 with the reason on an unreadable file', () => {
    const child = spawnSync(process.execPath, [SCRIPT, '--agreed', path.join(tmpdir(), 'no-such-agreed-line.txt'), '--args', path.join(tmpdir(), 'no-such-args.json')], { encoding: 'utf8' })

    expect(child.status).toBe(2)
    expect(child.stderr).toContain('cannot read')
  })
})
