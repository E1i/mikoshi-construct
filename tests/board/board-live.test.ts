import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { printBoard } from '../../scripts/cli/board-page.js'
import { writeBus } from './bus-fixture.js'

const NOW = new Date('2026-11-08T12:00:00.000Z')
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function seededBus(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'board-live-'))
  roots.push(root)
  return writeBus(path.join(root, 'bus.db'), {
    cards: [
      { id: 1701, state: 'queued', lane: 'lane-1', line: '#1701 queued' },
      { id: 1702, state: 'ready', lane: 'lane-1', line: '#1702 ready' },
      { id: 1703, state: 'stopped', lane: 'lane-1', line: '#1703 stopped' },
      { id: 1704, state: 'merged', lane: 'lane-1', line: '#1704 merged' },
      { id: 1705, state: 'queued', lane: 'archive', line: '#1705 archived' },
      { id: 1706, state: 'stopped', lane: 'lane-1', line: '#1706 stopped, nothing leased' },
    ],
    tasks: [{ queue: 'review', card: 1703, pr: null, head: null, state: 'leased' }],
    events: [{ ts: NOW.toISOString(), type: 'netwatch.tick', card: null, payload: '{}' }],
  })
}

function boardJson(busPath: string, liveOnly: boolean): { cards: { id: number }[], waits: unknown[] } {
  let text = ''
  expect(printBoard(busPath, NOW, (chunk) => {
    text += chunk
  }, path.join(path.dirname(busPath), 'miko.md'), 'json', path.join(path.dirname(busPath), 'eddies.json'), liveOnly)).toBe(0)
  return JSON.parse(text) as { cards: { id: number }[], waits: unknown[] }
}

it('board --json --live lists only live cards', () => {
  const busPath = seededBus()
  const all = boardJson(busPath, false)
  const live = boardJson(busPath, true)
  expect(all.cards.map(card => card.id).sort()).toEqual([1701, 1702, 1703, 1704, 1705, 1706])
  expect(live.cards.map(card => card.id).sort()).toEqual([1701, 1702, 1703])
  expect(Object.keys(live)).toEqual(Object.keys(all))
})
