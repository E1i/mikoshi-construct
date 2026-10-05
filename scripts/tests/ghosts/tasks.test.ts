import { describe, expect, it } from 'vitest'
import { parseTasksFile, startedTree } from '../../ghosts/tasks.js'

const CARD = '#160 window-close [implement/ghosts/S/ladder/owner] · depends — · blocks —'

const VALID = JSON.stringify({
  repo: '/w/main',
  status: '/w/handoff/status.md',
  out: '/w/handoff',
  tasks: [{ id: 'g1', brief: '/w/handoff/brief-g1.md', card: CARD }],
})

describe('parseTasksFile', () => {
  it('reads a valid tasks file', () => {
    const parsed = parseTasksFile(VALID)
    expect(parsed).toMatchObject({
      repo: '/w/main',
      status: '/w/handoff/status.md',
      out: '/w/handoff',
      tasks: [{ id: 'g1', brief: '/w/handoff/brief-g1.md', card: { id: 160, name: 'window-close', line: CARD } }],
    })
    expect(Object.keys(parsed.tasks[0]!).sort()).toEqual(['brief', 'card', 'id'])
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

  for (const field of ['id', 'brief', 'card'] as const) {
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

  it.each(['worktree', 'branch'])('refuses a task naming its own %s: the tree and branch come from the card\'s task:start line', (field) => {
    const object = JSON.parse(VALID) as { tasks: [Record<string, unknown>] }
    object.tasks[0][field] = '/w/wt-g1'
    expect(() => parseTasksFile(JSON.stringify(object))).toThrow(new RegExp(`tasks\\[0\\].*unknown field '${field}'`))
  })

  it('refuses a task card that is not a card, naming the field', () => {
    const object = JSON.parse(VALID) as { tasks: [Record<string, unknown>] }
    object.tasks[0].card = 'not a card'
    expect(() => parseTasksFile(JSON.stringify(object))).toThrow(/tasks\[0\] field card: 'not a card' is not a card/)
  })
})

describe('startedTree', () => {
  const card = parseTasksFile(VALID).tasks[0]!.card
  const line = (fields: object): string => `${JSON.stringify({ event: 'path', path: 'ladder', ts: '2026-10-06T08:00:00Z', ...fields })}\n`

  it('reads the tree and branch of the last task:start line of the card', () => {
    const journal = line({ task: '160', worktree: '/w/old', branch: 'feat/old' }) + line({ task: '161', worktree: '/w/other', branch: 'feat/other' }) + line({ task: '160', worktree: '/w/mc-160', branch: 'feat/window-close' })
    expect(startedTree(journal, card)).toEqual({ worktree: '/w/mc-160', branch: 'feat/window-close' })
  })

  it.each([
    { name: 'no line names the card', journal: line({ task: '161', worktree: '/w/other', branch: 'feat/other' }) },
    { name: 'the card\'s lines carry no tree', journal: line({ task: '160', pr: 7 }) },
    { name: 'a line is not JSON', journal: '{ not json\n' },
    { name: 'the journal is empty', journal: '' },
  ])('finds no tree when $name', ({ journal }) => {
    expect(startedTree(journal, card)).toBeUndefined()
  })

  it('skips a later line of the card that carries no tree', () => {
    const journal = line({ task: '160', worktree: '/w/mc-160', branch: 'feat/window-close' }) + line({ task: '160', pr: 7 })
    expect(startedTree(journal, card)).toEqual({ worktree: '/w/mc-160', branch: 'feat/window-close' })
  })
})
