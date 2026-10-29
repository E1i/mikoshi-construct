import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = path.resolve(import.meta.dirname, '..')

function read(relative: string): string {
  return readFileSync(path.join(ROOT, relative), 'utf8')
}

function tableAfter(text: string, header: string): string[][] {
  const lines = text.split('\n')
  const start = lines.findIndex(l => l.startsWith(header))
  const rows: string[][] = []
  for (const l of lines.slice(start + 2)) {
    if (!l.startsWith('|'))
      break
    rows.push(l.split('|').slice(1, -1).map(c => c.trim()))
  }
  return rows
}

const plan = read('templates/ai/claude/_claude/commands/plan.md')
const flat = plan.split('\n').map(l => l.trim()).filter(l => l.length > 0).join(' ')
const levels = tableAfter(plan, '| Risk |')
const row = (name: string): string[] => levels.find(r => r[0] === name) ?? ['', '', '']

describe('the plan reads risk before it chooses a contour', () => {
  it('reads the risk from what the change does, never from the words of the task', () => {
    expect(flat).toContain('risk before its contour')
    expect(flat).toContain('The risk is read from what the change does when it runs')
    expect(flat).toContain('never from the words of the task, the ticket or the names of its files')
    expect(flat).toContain('is a reason to look at the work, not a sign')
  })

  it('has three levels, the highest asks for a full review and a human merge, and none asks for a contour', () => {
    expect(levels.map(r => r[0])).toEqual(['critical', 'moderate', 'low'])
    expect(row('critical')[2]).toContain('reads the whole change')
    expect(row('critical')[2]).toContain('human who merges')
    for (const level of levels)
      expect(level[2], level[0]).not.toMatch(/ladder|cheap|contour/)
    expect(new Set(levels.map(r => r[2])).size).toBe(levels.length)
    for (const sign of ['authentication', 'permissions', 'money', 'personal data', 'migration', 'secrets', 'someone else owns', 'core'])
      expect(row('low')[1], sign).not.toContain(sign)
  })

  it('lets the highest sign decide and never lets risk set the contour', () => {
    expect(flat).toContain('The highest sign found decides')
    expect(flat).toContain('When two levels both fit, take the higher')
    expect(flat).toContain('Risk sets the review depth and who merges, never the contour')
    expect(flat).toContain('A critical task still takes the cheap path unless the owner sends it to the ladder')
    expect(flat).toContain('Every task takes the cheap path, whatever its class and whatever its risk')
    expect(flat).toContain('`ladder: owner <where the owner gave the word on this task> — <the reason>`')
    expect(flat).not.toContain('Risk only raises a contour')
    expect(flat.toLowerCase()).not.toContain('take the lower')
    expect(flat).toContain('risk: <level>, <sign>; acceptance:')
  })

  it('carries no example of this repository in the template', () => {
    expect(plan).not.toMatch(/PR #\d+/)
  })

  it('reads every worked example in window.md at a level the plan defines', () => {
    const rows = tableAfter(read('architecture/window.md'), '| Task | What the change does |')
    const defined = levels.map(r => r[0])

    expect(rows).toHaveLength(5)
    for (const r of rows)
      expect(defined, r[0]).toContain(r[3].split(':')[0].trim())
    const differs = rows.map(r => r[5].split(':')[0].trim())
    expect(differs).toContain('yes')
    expect(differs).toContain('no')
  })
})
