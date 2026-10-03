import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { renderPrompt } from '../../shift/prompt.js'
import { parseTaskFile } from '../../shift/task-file.js'

const HEADER = readFileSync(path.join(import.meta.dirname, '../../shift/header.md'), 'utf8')
const PLACES = { worktree: '/tmp/tree', report: '/tmp/report.md' }
const PROBE_LINE = 'Прочитай .claude/skills/probe/SKILL.md целиком и работай по нему'

function promptOf(kind: 'implement' | 'probe', body: string): string {
  const card = `#9 task-9 [${kind}/runner/S/cheap/${kind === 'probe' ? 'none' : 'auto'}] · depends — · blocks —`
  const parsed = parseTaskFile('01.md', `card: ${card}\nbranch: b\ntouches: a\n\n${body}\n`)
  if (parsed.kind === 'refused')
    throw new Error(parsed.reason)
  return renderPrompt(HEADER, parsed.task, PLACES)
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
})
