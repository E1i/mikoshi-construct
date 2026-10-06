import type { ClaudeRun } from '../../shift/claude.js'
import { appendFileSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runClaude } from '../../shift/claude.js'
import { runShift } from '../../shift/shift.js'
import { captured, cardLine, depsOf, eventsOf, fakeGh, newWorld } from './fixtures/autopilot-world.js'

const WAITS = 'the merge waits for the owner\'s answer'

function appendingToReport(line: string): (run: ClaudeRun) => ReturnType<typeof runClaude> {
  return async (run) => {
    const exit = await runClaude(run)
    const report = /write the shift report to `([^`]+)`/.exec(run.prompt)![1]!
    appendFileSync(report, `${line}\n`)
    return exit
  }
}

function mergeCalls(calls: string[][]): string[][] {
  return calls.filter(args => args[0] === 'pr' && args.includes('101') && (args[1] === 'merge' || args.includes('body,headRefOid,files')))
}

describe('a report that asks the owner holds the merge', () => {
  it('an auto card whose report asks the owner is not armed', async () => {
    const world = newWorld([{ id: 1, body: 'do 1 STUB-QUESTION STUB-VERIFIED-run STUB-PR-101' }])
    const { gh, calls } = fakeGh({ 101: cardLine(1) })
    const io = captured()
    await runShift([world.shift, '--parking', world.parking], depsOf(world, gh, io))
    expect(mergeCalls(calls)).toEqual([])
    expect(readFileSync(path.join(world.shift, 'report-1.md'), 'utf8')).toContain(WAITS)
    expect(io.out.some(line => line.includes(WAITS))).toBe(true)
    expect(eventsOf(world, 'path')).toContainEqual(expect.objectContaining({ task: '1', pr: 101 }))
    expect(eventsOf(world, 'stop')).toMatchObject([{ task: '1', at: 'question', why: 'which way, owner?' }])
  })

  it('an auto card whose report waits for the owner is not armed', async () => {
    const world = newWorld([{ id: 1, body: 'do 1 STUB-VERIFIED-run STUB-PR-101' }])
    const { gh, calls } = fakeGh({ 101: cardLine(1) })
    const io = captured()
    await runShift([world.shift, '--parking', world.parking], depsOf(world, gh, io, { run: appendingToReport('Waiting for the owner: review and merge') }))
    expect(mergeCalls(calls)).toEqual([])
    expect(readFileSync(path.join(world.shift, 'report-1.md'), 'utf8')).toContain(WAITS)
    expect(io.out.some(line => line.includes(WAITS))).toBe(true)
    expect(eventsOf(world, 'path')).toContainEqual(expect.objectContaining({ task: '1', pr: 101 }))
    expect(eventsOf(world, 'stop')).toMatchObject([{ task: '1', at: 'merge', pr: 101 }])
  })

  it('an auto card with a plain report is armed', async () => {
    const world = newWorld([{ id: 1, body: 'do 1 STUB-VERIFIED-run STUB-PR-101' }])
    const { gh, calls } = fakeGh({ 101: cardLine(1) })
    const io = captured()
    await runShift([world.shift, '--parking', world.parking], depsOf(world, gh, io))
    expect(calls).toContainEqual(expect.arrayContaining(['pr', 'merge', '101']))
    expect(readFileSync(path.join(world.shift, 'report-1.md'), 'utf8')).not.toContain(WAITS)
    expect(eventsOf(world, 'stop')).toEqual([])
  })
})
