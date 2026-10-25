import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { liveDecisionOf } from '../../policy/live-decision.js'
import { detectionCommand } from '../../supervisor/supervisor.js'
import { liveWorkers } from '../../supervisor/workers.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function busDir(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'bus-live-decision-'))
  roots.push(root)
  return root
}

function decision(text: string, decisionId = 1): { decisionId: number, text: string, cards: number[] } {
  return { decisionId, text, cards: [] }
}

describe('live decision', () => {
  it('bus:bg --live without an owner decision for the queue is refused', () => {
    const dir = busDir()
    const result = detectionCommand(dir, 'merge', true, [])
    expect(result.exitCode).toBe(1)
    expect(result.stderr.join('\n')).toContain('merge')
    expect(result.stderr.join('\n')).toContain('pnpm decisions:add "[owner] allow-live merge"')
    expect(liveWorkers(dir)).toEqual([])
  })

  it('bus:bg --live with an owner decision for the queue switches it live', () => {
    const dir = busDir()
    const result = detectionCommand(dir, 'merge', true, [decision('[owner] allow-live merge')])
    expect(result.exitCode).toBe(0)
    expect(liveWorkers(dir)).toEqual(['merge'])
  })

  it('bus:bg --shadow needs no decision', () => {
    const dir = busDir()
    detectionCommand(dir, 'merge', true, [decision('allow-live merge')])
    const result = detectionCommand(dir, 'merge', false, [])
    expect(result.exitCode).toBe(0)
    expect(liveWorkers(dir)).toEqual([])
  })

  it('a decision naming another queue does not allow this one', () => {
    expect(liveDecisionOf([decision('[owner] allow-live review')], 'merge')).toBeNull()
    expect(liveDecisionOf([decision('[owner] allow-live review', 4), decision('allow-live merge', 5)], 'merge')).toBe(5)
  })
})
