import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { readResultFields } from '../../ghosts/result.js'

function reportFile(lines: string[]): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'ghosts-result-'))
  const file = path.join(dir, 'ghost-g1.jsonl')
  writeFileSync(file, `${lines.join('\n')}\n`)
  return file
}

describe('readResultFields', () => {
  it('is all null and missing when the report does not exist', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'ghosts-result-'))
    expect(readResultFields(path.join(dir, 'absent.jsonl'))).toEqual({
      resultLine: 'missing',
      total_cost_usd: null,
      num_turns: null,
      duration_ms: null,
      usage: null,
    })
  })

  it('is all null and missing when no line has type result', () => {
    const file = reportFile(['{"type":"system"}', '{"type":"assistant"}'])
    expect(readResultFields(file)).toEqual({
      resultLine: 'missing',
      total_cost_usd: null,
      num_turns: null,
      duration_ms: null,
      usage: null,
    })
  })

  it('reads the last result line, not an earlier one', () => {
    const early = '{"type":"result","total_cost_usd":9.99,"num_turns":99,"duration_ms":99999,"usage":{"a":1}}'
    const last = '{"type":"result","total_cost_usd":0.5,"num_turns":7,"duration_ms":1000,"usage":{"a":2}}'
    const file = reportFile(['{"type":"system"}', early, '{"type":"assistant"}', last])

    expect(readResultFields(file)).toEqual({
      resultLine: 'present',
      total_cost_usd: 0.5,
      num_turns: 7,
      duration_ms: null,
      usage: { a: 2 },
    })
  })

  it('measures duration_ms from the first to the last timestamped line, not from any result line', () => {
    const file = reportFile([
      '{"type":"system"}',
      '{"type":"user","timestamp":"2026-09-28T10:00:00.000Z"}',
      '{"type":"result","total_cost_usd":0.1,"num_turns":1,"duration_ms":45087,"usage":null}',
      '{"type":"assistant","timestamp":"2026-09-28T10:07:10.000Z"}',
      '{"type":"result","total_cost_usd":0.5,"num_turns":7,"duration_ms":37360,"usage":null}',
    ])
    expect(readResultFields(file).duration_ms).toBe(430_000)
  })

  it('measures duration_ms from the marks when the session left no result line', () => {
    const file = reportFile(['{"type":"user","timestamp":"2026-09-28T10:00:00.000Z"}', '{"type":"assistant","timestamp":"2026-09-28T10:00:01.500Z"}'])
    expect(readResultFields(file)).toEqual({ resultLine: 'missing', total_cost_usd: null, num_turns: null, duration_ms: 1500, usage: null })
  })

  it('has no duration_ms with fewer than two marks', () => {
    expect(readResultFields(reportFile(['{"type":"assistant","timestamp":"2026-09-28T10:00:00.000Z"}', '{"type":"result","duration_ms":1000}'])).duration_ms).toBeNull()
  })
})
