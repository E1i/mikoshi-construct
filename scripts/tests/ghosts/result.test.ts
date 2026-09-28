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
      duration_ms: 1000,
      usage: { a: 2 },
    })
  })
})
