import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { cardSessionOf } from '../../bus/answer-source.js'
import { defaultBusPath, openBus } from '../../bus/db.js'
import { importJournal } from '../../bus/import.js'
import { cardStartedLines, parseTasksFile, startedTree } from '../../ghosts/tasks.js'
import { busWithCardStarted } from './card-started-bus.js'

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

describe('startedTree reads card.started from the bus', () => {
  const card = parseTasksFile(VALID).tasks[0]!.card
  const line = (fields: object): string => `${JSON.stringify({ event: 'path', path: 'ladder', ts: '2026-10-06T08:00:00Z', task: '160', ...fields })}\n`

  it('finds the tree of a card that has card.started and no path line', () => {
    const bus = busWithCardStarted([{ cardId: 160, ts: '2026-10-06T09:00:00Z', payload: { session: 's', worktree: '/w/bus-160', branch: 'feat/bus' } }])
    try {
      expect(startedTree('', card, bus.file)).toEqual({ worktree: '/w/bus-160', branch: 'feat/bus' })
    }
    finally {
      bus.remove()
    }
  })

  it('prefers card.started over a path line of the same card', () => {
    const bus = busWithCardStarted([{ cardId: 160, ts: '2026-10-06T07:00:00Z', payload: { worktree: '/w/bus-160', branch: 'feat/bus' } }])
    try {
      expect(startedTree(line({ worktree: '/w/journal-160', branch: 'feat/journal' }), card, bus.file)).toEqual({ worktree: '/w/bus-160', branch: 'feat/bus' })
    }
    finally {
      bus.remove()
    }
  })

  it('falls back to the path line of a card started by a chain before card.started, and when there is no bus', () => {
    const bus = busWithCardStarted([{ cardId: 161, ts: '2026-10-06T09:00:00Z', payload: { worktree: '/w/bus-161', branch: 'feat/other' } }])
    try {
      const journal = line({ worktree: '/w/journal-160', branch: 'feat/journal' })
      expect(startedTree(journal, card, bus.file)).toEqual({ worktree: '/w/journal-160', branch: 'feat/journal' })
      expect(startedTree(journal, card, path.join(path.dirname(bus.file), 'absent.db'))).toEqual({ worktree: '/w/journal-160', branch: 'feat/journal' })
    }
    finally {
      bus.remove()
    }
  })
  it('a card started by a chain with no card.started still has its tree found by startedTree through the path line, and answer does not fail on no_card_tree', () => {
    const bus = busWithCardStarted([{ cardId: 161, ts: '2026-10-06T09:00:00Z', payload: { session: 's', worktree: '/w/bus-161', branch: 'feat/other' } }])
    const pathLine = line({ worktree: '/w/journal-160', branch: 'feat/journal', session: 'chain-1', shift: '/shift' })
    const db = openBus(bus.file)
    try {
      importJournal(db, pathLine)
      expect(startedTree(pathLine, card, bus.file)).toEqual({ worktree: '/w/journal-160', branch: 'feat/journal' })
      expect(cardSessionOf(db, 160)).toEqual({ session: 'chain-1', worktree: '/w/journal-160', branch: 'feat/journal' })
    }
    finally {
      db.close()
      bus.remove()
    }
  })
})

describe('the test environment', () => {
  it('points the bus at an empty temporary bus of this test file, so a reader given no bus path never reads the bus of this machine', () => {
    const bus = defaultBusPath()
    expect(bus).not.toBe(path.join(os.homedir(), '.construct', 'bus.db'))
    expect(path.relative(os.tmpdir(), bus).startsWith('..')).toBe(false)
    expect(cardStartedLines(bus)).toEqual([])
  })
})
