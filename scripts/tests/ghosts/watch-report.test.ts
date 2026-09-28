import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { lastToolName, reportAgeSeconds } from '../../ghosts/watch-report.js'

function reportPath(): { dir: string, report: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'ghosts-watch-report-'))
  return { dir, report: path.join(dir, 'ghost-g1.jsonl') }
}

describe('reportAgeSeconds', () => {
  it('is null when the report is absent', () => {
    const { report } = reportPath()
    expect(reportAgeSeconds(report)).toBeNull()
  })

  it('is the whole seconds since the report was last written', () => {
    const { report } = reportPath()
    writeFileSync(report, '{}\n')
    expect(reportAgeSeconds(report)).toBeGreaterThanOrEqual(-1)
    expect(reportAgeSeconds(report)).toBeLessThan(5)
  })
})

describe('lastToolName', () => {
  it('is null when the report is absent', () => {
    const { report } = reportPath()
    expect(lastToolName(report)).toBeNull()
  })

  it('is none when the report has no tool_use', () => {
    const { report } = reportPath()
    writeFileSync(report, `${JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'thinking' }] } })}\n`)
    expect(lastToolName(report)).toBeNull()
  })

  it('picks a later tool_use over an earlier one', () => {
    const { report } = reportPath()
    const lines = [
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Read' }] } },
      { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit' }] } },
    ]
    writeFileSync(report, `${lines.map(line => JSON.stringify(line)).join('\n')}\n`)
    expect(lastToolName(report)).toBe('Edit')
  })

  it('picks a later tool_use within the same line over an earlier one in that line', () => {
    const { report } = reportPath()
    const line = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Read' }, { type: 'tool_use', name: 'Grep' }] } }
    writeFileSync(report, `${JSON.stringify(line)}\n`)
    expect(lastToolName(report)).toBe('Grep')
  })

  it('skips a half-written last line and reads the tool_use before it', () => {
    const { report } = reportPath()
    const good = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit' }] } }
    writeFileSync(report, `${JSON.stringify(good)}\n{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","name":"Wri`)
    expect(lastToolName(report)).toBe('Edit')
  })

  it('finds a tool_use inside the last 262144 bytes of a large report', () => {
    const { report } = reportPath()
    const filler = `x`.repeat(1000)
    const lines: string[] = []
    for (let i = 0; i < 300; i += 1)
      lines.push(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `filler ${filler}` }] } }))
    lines.push(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit' }] } }))
    writeFileSync(report, `${lines.join('\n')}\n`)
    expect(lastToolName(report)).toBe('Edit')
  })

  it('does not find a tool_use before the last 262144 bytes of a large report', () => {
    const { report } = reportPath()
    const filler = `x`.repeat(1000)
    const lines: string[] = []
    lines.push(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit' }] } }))
    for (let i = 0; i < 300; i += 1)
      lines.push(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `filler ${filler}` }] } }))
    writeFileSync(report, `${lines.join('\n')}\n`)
    expect(lastToolName(report)).toBeNull()
  })
})
