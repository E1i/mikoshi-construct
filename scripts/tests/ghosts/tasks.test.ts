import { describe, expect, it } from 'vitest'
import { parseTasksFile } from '../../ghosts/tasks.js'

const VALID = JSON.stringify({
  repo: '/w/main',
  status: '/w/handoff/status.md',
  out: '/w/handoff',
  tasks: [{ id: 'g1', brief: '/w/handoff/brief-g1.md', worktree: '/w/wt-g1', branch: 'ghost/g1' }],
})

describe('parseTasksFile', () => {
  it('reads a valid tasks file', () => {
    const parsed = parseTasksFile(VALID)
    expect(parsed).toEqual({
      repo: '/w/main',
      status: '/w/handoff/status.md',
      out: '/w/handoff',
      tasks: [{ id: 'g1', brief: '/w/handoff/brief-g1.md', worktree: '/w/wt-g1', branch: 'ghost/g1' }],
    })
  })

  it('refuses invalid JSON', () => {
    expect(() => parseTasksFile('not json')).toThrow(/not valid JSON/)
  })

  it('refuses a non-object root', () => {
    expect(() => parseTasksFile('[]')).toThrow(/expected a JSON object/)
  })

  for (const field of ['repo', 'status', 'out', 'tasks'] as const) {
    it(`refuses a missing top-level field '${field}', naming it`, () => {
      const object = JSON.parse(VALID) as Record<string, unknown>
      delete object[field]
      expect(() => parseTasksFile(JSON.stringify(object))).toThrow(new RegExp(`missing field '${field}'`))
    })
  }

  it('refuses an unknown top-level field, naming it', () => {
    const object = { ...JSON.parse(VALID) as Record<string, unknown>, extra: true }
    expect(() => parseTasksFile(JSON.stringify(object))).toThrow(/unknown field 'extra'/)
  })

  it('accepts an optional top-level matrix', () => {
    const object = { ...JSON.parse(VALID) as Record<string, unknown>, matrix: '/w/matrix.json' }
    const parsed = parseTasksFile(JSON.stringify(object))
    expect(parsed.matrix).toBe('/w/matrix.json')
  })

  it('leaves matrix undefined when absent', () => {
    const parsed = parseTasksFile(VALID)
    expect(parsed.matrix).toBeUndefined()
  })

  it('still refuses an unknown top-level field alongside a matrix, naming it', () => {
    const object = { ...JSON.parse(VALID) as Record<string, unknown>, matrix: '/w/matrix.json', matrx: '/w/oops.json' }
    expect(() => parseTasksFile(JSON.stringify(object))).toThrow(/unknown field 'matrx'/)
  })

  it('refuses a non-array tasks field', () => {
    const object = { ...JSON.parse(VALID) as Record<string, unknown>, tasks: 'nope' }
    expect(() => parseTasksFile(JSON.stringify(object))).toThrow(/tasks: expected an array/)
  })

  for (const field of ['id', 'brief', 'worktree', 'branch'] as const) {
    it(`refuses a task missing '${field}', naming it`, () => {
      const object = JSON.parse(VALID) as { tasks: [Record<string, unknown>] }
      delete object.tasks[0][field]
      expect(() => parseTasksFile(JSON.stringify(object))).toThrow(new RegExp(`tasks\\[0\\].*missing field '${field}'`))
    })
  }

  it('refuses a task with an unknown field, naming it', () => {
    const object = JSON.parse(VALID) as { tasks: [Record<string, unknown>] }
    object.tasks[0].extra = true
    expect(() => parseTasksFile(JSON.stringify(object))).toThrow(/tasks\[0\].*unknown field 'extra'/)
  })

  it('refuses an empty string field', () => {
    const object = JSON.parse(VALID) as { tasks: [Record<string, unknown>] }
    object.tasks[0].id = ''
    expect(() => parseTasksFile(JSON.stringify(object))).toThrow(/expected a non-empty string/)
  })
})
