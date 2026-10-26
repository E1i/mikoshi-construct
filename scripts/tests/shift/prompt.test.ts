import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseTaskFile } from '../../../src/card/task-file.js'
import { readShiftGate } from '../../../src/manifest.js'
import { PREPUSH_COMMAND } from '../../ci/prepush.js'
import { HANDOFF_FIELDS } from '../../core/handoff-fields.js'
import { renderPrompt } from '../../nodes/launch/prompt.js'

const HEADER = readFileSync(path.join(import.meta.dirname, '../../nodes/launch/header.md'), 'utf8')
const OWN_GATE = readShiftGate(path.join(import.meta.dirname, '../../..'))
const UNDECLARED_GATE = { prepush: ['pnpm run quality'], handoffWrite: null, codeMatrix: null }
const PLACES = { worktree: '/tmp/tree', report: '/tmp/report.md', gate: OWN_GATE }
const PROBE_LINE = 'Прочитай .claude/skills/probe/SKILL.md целиком и работай по нему'

function promptOf(kind: 'implement' | 'probe', body: string, places = PLACES): string {
  const card = `#9 task-9 [${kind}/runner/S/cheap/${kind === 'probe' ? 'none' : 'auto'}] · depends — · blocks —`
  const parsed = parseTaskFile('01.md', `card: ${card}\nbranch: b\ntouches: a\n\n${body}\n`)
  if (parsed.kind === 'refused')
    throw new Error(parsed.reason)
  return renderPrompt(HEADER, parsed.task, places)
}

function countOf(text: string, line: string): number {
  return text.split('\n').filter(candidate => candidate === line).length
}

describe('renderPrompt', () => {
  it('puts the probe skill line right before the body of a probe task', () => {
    expect(promptOf('probe', 'Look at the target.')).toContain(`---\n\n${PROBE_LINE}\n\nLook at the target.\n`)
  })

  it('gives an implement task no probe skill line', () => {
    expect(promptOf('implement', 'Do it.')).not.toContain('.claude/skills/probe/SKILL.md')
  })

  it('does not repeat the probe skill line a probe body already carries', () => {
    expect(countOf(promptOf('probe', `${PROBE_LINE}\n\nLook at the target.`), PROBE_LINE)).toBe(1)
  })

  it('adds no probe skill line to a probe body that already points at the skill', () => {
    expect(promptOf('probe', 'Read .claude/skills/probe/SKILL.md first.\n\nLook at the target.')).not.toContain(PROBE_LINE)
  })

  it('tells the session to put a question for the owner on a question: line of the report, which the runner reads', () => {
    expect(promptOf('implement', 'Do it.')).toContain('`question: <what the owner decides>`')
  })

  it('tells a session in this repository to run the pre-push tests, typecheck and lint its construct.json declares, not pnpm run quality', () => {
    const prompt = promptOf('implement', 'Do it.')
    expect(prompt).toContain(PREPUSH_COMMAND)
    expect(prompt).toContain('`pnpm typecheck`')
    expect(prompt).toContain('`pnpm lint`')
    expect(prompt).not.toContain('pnpm run quality')
  })

  it('keeps the code matrix and handoff:write lines in this repository, which declares both', () => {
    const prompt = promptOf('implement', 'Do it.')
    expect(prompt).toContain('`architecture/code-matrix.md`')
    expect(prompt).toContain('`pnpm handoff:write <handoff> <draft>`')
  })

  it('drops the code matrix and handoff:write lines, and every section marker, where the repository declares neither', () => {
    const prompt = promptOf('implement', 'Do it.', { ...PLACES, gate: UNDECLARED_GATE })
    expect(prompt).not.toContain('code matrix')
    expect(prompt).not.toContain('handoff:write')
    expect(prompt).not.toMatch(/\{\{[?/]?\w+\}\}/)
    expect(prompt).toContain('`pnpm run quality`')
  })

  it('names the handoff fields inline instead of the file of this repository that lists them', () => {
    const prompt = promptOf('implement', 'Do it.', { ...PLACES, gate: UNDECLARED_GATE })
    expect(prompt).not.toContain('handoff-check.ts')
    for (const field of HANDOFF_FIELDS)
      expect(prompt).toContain(`\`${field.label}\``)
  })
})
