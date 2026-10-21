import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { knownWriteSites, projectionWriteSites, repositorySources, sortedSites, staleSites, unrecordedSites } from '../../bus/projection-writes.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..')

function withExtra(file: string, text: string): Map<string, string> {
  const sources = repositorySources(REPO_ROOT)
  sources.set(file, `${sources.get(file) ?? ''}\n${text}\n`)
  return sources
}

const SAMPLE_FOLDS = `
import type { Fold } from './stored.js'
function foldNoted(db, event) {
  db.prepare('UPDATE tasks SET state = ? WHERE task_key = ?').run('x', event.id)
}
export const NOTE_FOLDS: Record<string, Fold> = { ['note.made']: foldNoted }
`

describe('the projection tables are written by the reducer, and every other write site is recorded', () => {
  const found = projectionWriteSites(repositorySources(REPO_ROOT))
  const known = knownWriteSites(REPO_ROOT)

  it('the write sites outside the reducer are exactly the recorded baseline', () => {
    expect(unrecordedSites(found, known)).toEqual([])
    expect(staleSites(found, known)).toEqual([])
    expect(known).toEqual(sortedSites(known))
  })

  it('roles and tasks stand in no write site outside the reducer', () => {
    expect(found.filter(site => site.table === 'roles' || site.table === 'tasks')).toEqual([])
    expect(known.filter(site => site.table === 'roles' || site.table === 'tasks')).toEqual([])
    expect(found.map(site => site.table)).toEqual(expect.arrayContaining(['chains', 'cards']))
  })

  it('a new write into a projection table outside the reducer fails, even in a file that holds folds', () => {
    const raw = projectionWriteSites(withExtra('scripts/bus/queue.ts', `export function sneak(db) {\n  db.prepare('UPDATE tasks SET state = ? WHERE task_key = ?').run('queued', 'k')\n}`))
    expect(unrecordedSites(raw, known)).toEqual([{ file: 'scripts/bus/queue.ts', unit: 'sneak', table: 'tasks', operation: 'update' }])

    const folded = projectionWriteSites(withExtra('scripts/bus/queue.ts', `export function sneakFold(db, event) {\n  TASKS_FOLDS[event.type](db, event)\n}`))
    expect(unrecordedSites(folded, known)).toEqual([
      { file: 'scripts/bus/queue.ts', unit: 'sneakFold', table: 'tasks', operation: 'insert' },
      { file: 'scripts/bus/queue.ts', unit: 'sneakFold', table: 'tasks', operation: 'update' },
    ])
  })

  it('a write inside a fold, and in what a fold calls, belongs to the reducer and is no site', () => {
    const sources = new Map([['scripts/bus/note.ts', SAMPLE_FOLDS]])
    expect(projectionWriteSites(sources)).toEqual([])
    sources.set('scripts/bus/note-writer.ts', `import { NOTE_FOLDS } from './note.js'\nexport function noted(db, event) {\n  NOTE_FOLDS['note.made'](db, event)\n}`)
    expect(projectionWriteSites(sources)).toEqual([{ file: 'scripts/bus/note-writer.ts', unit: 'noted', table: 'tasks', operation: 'update' }])
  })

  it('a recorded site that no longer exists fails, so the list only shrinks', () => {
    const gone = { file: 'scripts/bus/role.ts', unit: 'folded', table: 'roles', operation: 'update' } as const
    expect(staleSites(found, [...known, gone])).toEqual([gone])
  })
})
