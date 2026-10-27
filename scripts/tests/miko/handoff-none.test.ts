import { describe, expect, it } from 'vitest'
import { HANDOFF_FIELDS } from '../../core/handoff-fields.js'
import { decisionsPath, handoffRefusals } from '../../window/handoff-check.js'
import { nextTaskFormRefusals } from '../../window/handoff-write.js'

function handoff(decisions: string): string {
  const values: Record<string, string> = { ...Object.fromEntries(HANDOFF_FIELDS.map(field => [field.label, `${field.id} value`])), 'queue': 'none', 'decisions': decisions, 'prev': 'none', 'in-flight': 'none' }
  return `# Handoff\n\n## STOP — window 1\n${Object.entries(values).map(([label, value]) => `${label}: ${value}`).join('\n')}\n\nSTATUS: CONTINUE`
}

function draft(status: string, nextTask: string): string {
  return `# Handoff\n\nrole: window\nsession: 2\nnext task: ${nextTask}\n\nSTATUS: ${status}\n`
}

describe('the handoff accepts none where there is nothing', () => {
  it('decisions: none is the same as no decisions file', () => {
    expect(decisionsPath(handoff('none'), '/h/handoff.md', '/home/x')).toBeNull()
    expect(decisionsPath(handoff('None'), '/h/handoff.md', '/home/x')).toBeNull()
    expect(handoffRefusals(handoff('none'), { file: '/h/handoff.md', home: '/home/x', exists: () => false, parked: new Map() })).toEqual([])
  })

  it('next task: none is accepted with STATUS: DONE', () => {
    expect(nextTaskFormRefusals(draft('DONE', 'none'))).toEqual([])
  })

  it('next task: none is refused with STATUS: CONTINUE', () => {
    expect(nextTaskFormRefusals(draft('CONTINUE', 'none'))).toHaveLength(1)
  })
})
