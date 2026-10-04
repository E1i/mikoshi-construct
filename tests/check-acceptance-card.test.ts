import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { ENTRY_RESULT as FACTORY_ENTRY_RESULT } from '../scripts/ghosts/entry.js'
import { PLAIN_STYLE, renderSignal, SIGNAL_FIELDS } from '../src/ui/signal.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const SCRIPT = path.join(REPO_ROOT, 'scripts/construct/check-acceptance.mjs')
const TEMPLATE_SKILL = 'templates/ai/claude/_claude/skills/implement/SKILL.md'
const FORECAST = 'tokens ≈ 160k, minutes ≈ 7.5 — effort medium, n=64, median'
const BRIEF = [
  '/implement do a thing',
  'Sketch: none — x',
  `expect: ${FORECAST}`,
  'Effort: medium — x',
  'Acceptance: a — witness: `true`; b — witness: `true`',
  'Immutable: `a/`',
].join('\n')
const BARE_BRIEF = 'do a thing'

interface CheckAcceptance {
  card: (argv: string[]) => { code: number, stdout: string[], stderr: string[] }
  intakeSignal: (text: string) => { title: string, signal: Record<typeof SIGNAL_FIELDS[number], string> }
  ENTRY_RESULT: string
}

const { card, ENTRY_RESULT, intakeSignal } = await import(pathToFileURL(SCRIPT).href) as CheckAcceptance

const dirs: string[] = []

function briefFile(text: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'card-'))
  dirs.push(dir)
  const file = path.join(dir, 'agreed.txt')
  writeFileSync(file, text)
  return file
}

function cardOf(text: string, ...flags: string[]): string[] {
  const result = card(['--brief', briefFile(text), ...flags])
  expect(result.code).toBe(0)
  return result.stdout
}

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

describe('the entry card of /implement', () => {
  it('prints the four fields in the order of SIGNAL_FIELDS with the entry RESULT', () => {
    const lines = cardOf(BRIEF)
    expect(lines).toHaveLength(1 + SIGNAL_FIELDS.length)
    expect(lines.slice(1).map(line => line.split(' ')[0])).toEqual([...SIGNAL_FIELDS])
    expect(lines[4]).toBe('RESULT   | accepted · not started')
  })

  it('reads CONTRACT and EXPECT from the brief and never from an estimate', () => {
    const lines = cardOf(BRIEF)
    expect(lines[1]).toBe('CONTRACT | do a thing · effort medium · 2 acceptance items · 1 immutable paths')
    expect(lines[2]).toBe(`EXPECT   | expect ${FORECAST}`)
  })

  it('names every value the brief does not hold as not recorded in the brief', () => {
    const lines = cardOf(BARE_BRIEF)
    expect(lines[1]).toBe('CONTRACT | do a thing · effort not recorded in the brief · acceptance not recorded in the brief · immutable not recorded in the brief')
    expect(lines[2]).toBe('EXPECT   | expect not recorded in the brief')
  })

  it('is byte for byte what renderSignal prints in its plain form for the same signal', () => {
    for (const text of [BRIEF, BARE_BRIEF]) {
      const { title, signal } = intakeSignal(text)
      expect(cardOf(text)).toEqual(renderSignal(title, signal, PLAIN_STYLE))
    }
  })

  it('holds the factory\'s entry RESULT, one value in two readers', () => {
    expect(ENTRY_RESULT).toBe(FACTORY_ENTRY_RESULT)
  })

  it('repeats the entry CONTRACT and EXPECT byte for byte on the exit card', () => {
    const entry = cardOf(BRIEF)
    const exit = cardOf(BRIEF, '--action', 'run wf_1; rung 1 low passed', '--result', 'done')
    expect(exit[1]).toBe(entry[1])
    expect(exit[2]).toBe(entry[2])
    expect(exit[3]).toBe('ACTION   | run wf_1; rung 1 low passed')
    expect(exit[4]).toBe('RESULT   | done')
  })

  it('exits 2 and says so on stderr when the brief cannot be read', () => {
    const result = spawnSync('node', [SCRIPT, 'card', '--brief', '/nonexistent/agreed.txt'], { encoding: 'utf8' })
    expect(result.status).toBe(2)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('cannot read /nonexistent/agreed.txt')
  })

  it('prints the same bytes when run as a command', () => {
    const file = briefFile(BRIEF)
    const result = spawnSync('node', [SCRIPT, 'card', '--brief', file], { encoding: 'utf8' })
    expect(result.stdout).toBe(`${cardOf(BRIEF).join('\n')}\n`)
  })
})

describe('the /implement skill template', () => {
  const text = readFileSync(path.join(REPO_ROOT, TEMPLATE_SKILL), 'utf8')

  it('opens with step 0, the entry card, before the classification of step 1', () => {
    const step0 = text.indexOf('\n0. Before the first token')
    expect(step0).toBeGreaterThan(-1)
    expect(step0).toBeLessThan(text.indexOf('\n1. Classify the effort class'))
    expect(text).toContain('check-acceptance.mjs card --brief .construct/implement-agreed.txt` and print')
  })

  it('opens the final report with the exit card, whose CONTRACT and EXPECT are the entry\'s', () => {
    const step5 = text.slice(text.indexOf('\n5. Relay the result.'))
    expect(step5).toContain('check-acceptance.mjs card --brief .construct/implement-agreed.txt --action')
    expect(step5).toContain('`CONTRACT` and `EXPECT` rows are the entry card\'s byte for byte')
  })
})
