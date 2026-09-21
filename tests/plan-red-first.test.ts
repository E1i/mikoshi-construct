import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const PLAN = path.resolve(import.meta.dirname, '../templates/ai/claude/_claude/commands/plan.md')

function planCommand(): string {
  return readFileSync(PLAN, 'utf8')
}

describe('the plan command carries the requirement that a criterion is seen failing first', () => {
  it('requires a criterion that can fail today to be shown failing before the change', () => {
    const rules = planCommand()

    expect(rules).toContain('can fail against the repository as it stands')
    expect(rules).toContain('show it failing before the change')
  })

  it('says nothing about a criterion that cannot fail today, because that question is open', () => {
    const rules = planCommand().toLowerCase()

    for (const decided of ['regression', 'guard against', 'wrong implementation', 'every criterion', 'always red'])
      expect(rules, decided).not.toContain(decided)
  })

  it('cites no record of the repository that ships it, because it materializes into other people\'s', () => {
    const rules = planCommand()

    expect(rules).not.toContain('observations.md')
    expect(rules).not.toContain('architecture/decisions')
    expect(rules).not.toMatch(/\bdecision \d{4}\b/i)
  })
})
