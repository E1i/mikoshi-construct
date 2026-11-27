import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..')
const EDDIES_MEASURE = 'scripts/window/eddies-measure.ts'
const ROLE = 'scripts/nodes/restart/role.ts'
const EXIT = 'scripts/window/exit.ts'
const DERIVE_QUEUES = 'scripts/supervisor/derive-queues.ts'
const QUEUE = 'scripts/core/queue.ts'
const THRESHOLDS = 'THRESHOLDS'
const STOP_REASON = 'StopReason'
const LATEST_TURN_OF = 'latestTurnOf'
const QUEUE_READERS = ['reviewCandidates', 'closeCandidates', 'reviewsOfAnOldInput', 'reviewsOfTheCurrentInputAgain', 'reviewKeysOfAnOldInput', 'reviewKeysOfTheCurrentInputAgain'] as const

function sourceOf(file: string): string {
  return readFileSync(path.join(REPO_ROOT, file), 'utf8')
}

function declares(source: string, symbol: string): boolean {
  return new RegExp(`^(?:export )?(?:async )?(?:function|interface|const|let|class|type) ${symbol}\\b`, 'm').test(source)
}

function names(source: string, symbol: string): boolean {
  return new RegExp(`\\b${symbol}\\b`).test(source)
}

describe('the session vocabulary: THRESHOLDS and StopReason live in eddies-measure.ts and the six queue readers live in derive-queues.ts and not in queue.ts', () => {
  it('eddies-measure declares THRESHOLDS and StopReason', () => {
    const measure = sourceOf(EDDIES_MEASURE)
    expect(declares(measure, THRESHOLDS)).toBe(true)
    expect(declares(measure, STOP_REASON)).toBe(true)
  })

  it('role does not declare THRESHOLDS and exit does not declare StopReason', () => {
    expect(declares(sourceOf(ROLE), THRESHOLDS)).toBe(false)
    expect(declares(sourceOf(EXIT), STOP_REASON)).toBe(false)
  })

  it('derive-queues declares every one of the six queue readers', () => {
    const derive = sourceOf(DERIVE_QUEUES)
    expect(QUEUE_READERS.filter(symbol => !declares(derive, symbol))).toEqual([])
  })

  it('queue names none of the six and still declares latestTurnOf', () => {
    const queue = sourceOf(QUEUE)
    expect(QUEUE_READERS.filter(symbol => names(queue, symbol))).toEqual([])
    expect(declares(queue, LATEST_TURN_OF)).toBe(true)
  })
})
