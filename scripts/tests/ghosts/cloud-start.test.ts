import type { CloudStartDeps } from '../../ghosts/cloud-start.js'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runCloudStart } from '../../ghosts/cloud-start.js'

const HANDOFF = '/handoff'
const JOURNAL = path.join(HANDOFF, 'ghosts.jsonl')
const NOW = new Date('2026-10-07T09:00:00.000Z')
const CARD = '#665 probe-card [probe/ghosts/S/cheap/none] · depends — · blocks —'
const BASE = 'a'.repeat(40)

function intake(card: string): string {
  return JSON.stringify({ event: 'intake', task: /^#(\d+)/.exec(card)![1], card, confirmation: 'none', corrections: [], ts: 'x' })
}

function world(journal: string[]): { deps: CloudStartDeps, written: string[] } {
  const written: string[] = []
  return {
    written,
    deps: {
      read: file => file === JOURNAL ? `${journal.join('\n')}\n` : null,
      append: (file, text) => {
        expect(file).toBe(JOURNAL)
        written.push(text)
      },
      now: () => NOW,
      handoffDir: HANDOFF,
      base: () => BASE,
    },
  }
}

describe('cloud-start', () => {
  it('cloud-start writes one start line carrying the card and the run id', () => {
    const { deps, written } = world([intake(CARD)])
    const result = runCloudStart(['trig_1', '--card', CARD], deps)
    expect(result.exitCode).toBe(0)
    expect(written).toHaveLength(1)
    expect(JSON.parse(written[0]!)).toEqual({
      event: 'cloud-start',
      task: '665',
      card: { id: 665, name: 'probe-card', kind: 'probe', milestone: 'ghosts', size: 'S', contour: 'cheap', decision: 'none', depends: [], blocks: [], line: CARD },
      run: 'trig_1',
      base: BASE,
      ts: NOW.toISOString(),
    })
  })

  it('cloud-start refuses a card the intake door has not admitted and writes nothing', () => {
    const { deps, written } = world([intake('#666 other [probe/ghosts/S/cheap/none] · depends — · blocks —')])
    const result = runCloudStart(['trig_1', '--card', CARD], deps)
    expect(result.exitCode).toBe(1)
    expect(written).toEqual([])
  })

  it('cloud-start refuses a card whose intake line confirms a different version of it and writes nothing', () => {
    const { deps, written } = world([intake('#665 probe-card [probe/ghosts/M/cheap/none] · depends — · blocks —')])
    const result = runCloudStart(['trig_1', '--card', CARD], deps)
    expect(result.exitCode).toBe(1)
    expect(written).toEqual([])
  })

  it('cloud-start refuses a card that does not parse and writes nothing', () => {
    const { deps, written } = world([intake(CARD)])
    expect(runCloudStart(['trig_1', '--card', 'nonsense'], deps).exitCode).toBe(1)
    expect(written).toEqual([])
  })

  it('cloud-start refuses without a run id and writes nothing', () => {
    const { deps, written } = world([intake(CARD)])
    const result = runCloudStart(['--card', CARD], deps)
    expect(result.exitCode).toBe(1)
    expect(written).toEqual([])
  })
})
