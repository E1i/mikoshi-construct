import type { PathClass, PathState } from '../src/sync/classify.js'
import { describe, expect, it } from 'vitest'
import { classifyPath, classifyRepository, isWritable, PATH_CLASSES } from '../src/sync/classify.js'
import { ownedSha } from '../src/sync/ownership.js'

const TARGET = 'architecture/principles.md'

const RECORDED_TEXT = 'what the last run wrote\n'
const TEMPLATE_TEXT = 'what the templates produce today\n'
const OWNER_TEXT = 'what the owner wrote instead\n'

const RECORDED_SHA = ownedSha(TARGET, RECORDED_TEXT)

interface Row {
  cell: string
  state: PathState
  expected: PathClass | null
}

const ROWS: Row[] = [
  {
    cell: 'recorded no, present no, produced yes',
    state: { target: TARGET, recordedSha: null, present: null, produced: TEMPLATE_TEXT },
    expected: 'add',
  },
  {
    cell: 'recorded yes, present yes, produced yes — the current owned view is what the templates produce',
    state: { target: TARGET, recordedSha: RECORDED_SHA, present: TEMPLATE_TEXT, produced: TEMPLATE_TEXT },
    expected: 'keep',
  },
  {
    cell: 'recorded yes, present yes, produced yes — the current owned view is what was recorded',
    state: { target: TARGET, recordedSha: RECORDED_SHA, present: RECORDED_TEXT, produced: TEMPLATE_TEXT },
    expected: 'update',
  },
  {
    cell: 'recorded yes, present yes, produced yes — the current owned view is neither',
    state: { target: TARGET, recordedSha: RECORDED_SHA, present: OWNER_TEXT, produced: TEMPLATE_TEXT },
    expected: 'conflict',
  },
  {
    cell: 'recorded no, present yes, produced yes',
    state: { target: TARGET, recordedSha: null, present: OWNER_TEXT, produced: TEMPLATE_TEXT },
    expected: 'conflict',
  },
  {
    cell: 'recorded yes, present no, produced yes',
    state: { target: TARGET, recordedSha: RECORDED_SHA, present: null, produced: TEMPLATE_TEXT },
    expected: 'removed',
  },
  {
    cell: 'recorded yes, present no, produced no',
    state: { target: TARGET, recordedSha: RECORDED_SHA, present: null, produced: null },
    expected: 'removed',
  },
  {
    cell: 'recorded yes, present yes, produced no',
    state: { target: TARGET, recordedSha: RECORDED_SHA, present: RECORDED_TEXT, produced: null },
    expected: 'orphaned',
  },
  {
    cell: 'recorded no, present yes, produced no',
    state: { target: TARGET, recordedSha: null, present: OWNER_TEXT, produced: null },
    expected: 'foreign',
  },
  {
    cell: 'recorded no, present no, produced no',
    state: { target: TARGET, recordedSha: null, present: null, produced: null },
    expected: null,
  },
]

describe('the classes are exhaustive and mutually exclusive over recorded, present and produced', () => {
  it.each(ROWS)('$cell reads as $expected', ({ state, expected }) => {
    const classification = classifyPath(state)
    expect(classification?.class ?? null).toBe(expected)
  })

  it('names every class in the contract, and gives a path exactly one of them', () => {
    const reached = new Set(ROWS.map(row => row.expected).filter(value => value != null))
    expect([...reached].sort()).toEqual([...PATH_CLASSES].sort())
    for (const row of ROWS) {
      const others = PATH_CLASSES.filter(value => value !== row.expected)
      expect(others).not.toContain(classifyPath(row.state)?.class ?? null)
    }
  })

  it('reads a recorded path missing from the tree as removed, never as update', () => {
    const classification = classifyPath({ target: TARGET, recordedSha: RECORDED_SHA, present: null, produced: TEMPLATE_TEXT })
    expect(classification?.class).toBe('removed')
    expect(classification?.class).not.toBe('update')
  })

  it('reads a recorded path the templates no longer produce as orphaned, never as foreign', () => {
    const classification = classifyPath({ target: TARGET, recordedSha: RECORDED_SHA, present: RECORDED_TEXT, produced: null })
    expect(classification?.class).toBe('orphaned')
    expect(classification?.class).not.toBe('foreign')
  })

  it('reads a produced path occupied by a file no manifest recorded as conflict, never as add', () => {
    const classification = classifyPath({ target: TARGET, recordedSha: null, present: OWNER_TEXT, produced: TEMPLATE_TEXT })
    expect(classification?.class).toBe('conflict')
    expect(classification?.class).not.toBe('add')
  })

  it('considers the union of recorded, present and produced paths, and nothing else', () => {
    const classified = classifyRepository({
      recorded: { 'removed.md': RECORDED_SHA },
      present: { 'foreign.md': OWNER_TEXT },
      produced: { 'added.md': TEMPLATE_TEXT },
    })
    expect(classified.map(entry => [entry.target, entry.class])).toEqual([
      ['added.md', 'add'],
      ['foreign.md', 'foreign'],
      ['removed.md', 'removed'],
    ])
  })
})

describe('the ordered comparison inside recorded, present and produced', () => {
  it('reads an owner who applied by hand exactly what the template now brings as keep, never as conflict', () => {
    const appliedByHand = classifyPath({ target: TARGET, recordedSha: RECORDED_SHA, present: TEMPLATE_TEXT, produced: TEMPLATE_TEXT })
    expect(appliedByHand?.class).toBe('keep')
    expect(appliedByHand?.class).not.toBe('conflict')
  })

  it('asks what the templates produce before it asks what was recorded', () => {
    const state = { target: TARGET, recordedSha: RECORDED_SHA, present: TEMPLATE_TEXT, produced: TEMPLATE_TEXT }
    expect(classifyPath(state)?.class).toBe('keep')
    expect(classifyPath({ ...state, present: RECORDED_TEXT })?.class).toBe('update')
    expect(classifyPath({ ...state, present: OWNER_TEXT })?.class).toBe('conflict')
  })

  it('reads a file the record no longer describes and the templates have moved past as conflict', () => {
    const state = { target: TARGET, recordedSha: RECORDED_SHA, present: OWNER_TEXT, produced: TEMPLATE_TEXT }
    expect(classifyPath(state)?.class).toBe('conflict')
  })

  it('carries the target strategy on every classification', () => {
    expect(classifyPath({ target: 'package.json', recordedSha: null, present: null, produced: '{}' })?.strategy).toBe('merge-json')
    expect(classifyPath({ target: 'AGENTS.md', recordedSha: null, present: null, produced: 'x' })?.strategy).toBe('append-block')
    expect(classifyPath({ target: TARGET, recordedSha: null, present: null, produced: 'x' })?.strategy).toBe('create')
  })
})

describe('what sync may write is decided by the strategy, not by the class alone', () => {
  it('never lets a merge-json target be written, whatever class it carries', () => {
    for (const value of PATH_CLASSES)
      expect(isWritable({ target: 'package.json', strategy: 'merge-json', class: value, keys: [], writeEffect: null })).toBe(false)
  })

  it('lets only add and update through for a file the construct writes whole or by block', () => {
    for (const strategy of ['create', 'append-block'] as const) {
      const writable = PATH_CLASSES.filter(value => isWritable({ target: 'x', strategy, class: value, keys: [], writeEffect: null }))
      expect(writable).toEqual(['add', 'update'])
    }
  })

  it('refuses a package.json whose owned keys make the path update', () => {
    const classification = classifyPath({ target: 'package.json', recordedSha: 'recorded', present: '{"name":"a"}', produced: '{"name":"a","scripts":{}}' })
    expect(classification?.class).toBe('update')
    expect(isWritable(classification!)).toBe(false)
  })
})
