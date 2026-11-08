import type { LayerMap } from '../../core/layer-map.js'
import { expect, it } from 'vitest'
import { fileNamedIn, placementOf, recount } from '../../cli/no-layer-recount.js'

const MAP: LayerMap = { files: { 'contract/factory.json': 'contract' }, folders: { 'scripts/core/': 'core' } }

function denied(file: string): string {
  return JSON.stringify({ detail: `#1306 is updated onto main before it merges: ${file} belongs to no layer of the check catalog; the task is queued` })
}

it('names the file of a no-layer reason and places it by the one layer map', () => {
  expect(fileNamedIn(denied('architecture/window.md'))).toBe('architecture/window.md')
  expect(fileNamedIn('{"why":"nothing here"}')).toBeNull()
  expect(['architecture/window.md', 'scripts/tests/bus/a.test.ts', 'contract/factory.json', '.dependency-cruiser-known-violations.json', null].map(file => placementOf(file, MAP)))
    .toEqual(['docs', 'test', 'layer', 'full', 'full'])
})

it('counts the events that would no longer run the full suite, per event type', () => {
  const events = [
    { type: 'policy.denied', payload: denied('.claude/skills/intake/SKILL.md') },
    { type: 'policy.denied', payload: denied('package.json') },
    { type: 'card.admitted', payload: denied('tests/new.test.ts') },
  ]

  expect(recount(events, MAP)).toEqual({
    events: 3,
    notFull: 2,
    byPlacement: { docs: 1, test: 1, layer: 0, full: 1 },
    byType: { 'policy.denied': { events: 2, notFull: 1 }, 'card.admitted': { events: 1, notFull: 1 } },
  })
})
