import type { World } from './fixtures/autopilot-world.js'
import { appendFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runShift } from '../../shift/shift.js'
import { captured, cardLine, eventsOf, fakeGh, newWorld, stubRuns } from './fixtures/autopilot-world.js'
import { approve, LADDER, ladderDeps, ladderPnpm } from './fixtures/ladder-world.js'

async function shiftOver(world: World, dir: string): Promise<{ out: string[], steps: number }> {
  const ladder = ladderPnpm(world, 1)
  const { gh } = fakeGh({ 101: cardLine(1, LADDER) })
  const io = captured()
  await runShift([dir, '--parking', world.parking, '--queue'], ladderDeps(world, gh, io, ladder))
  return { out: io.out, steps: ladder.calls.length }
}

function standingMergeStop(world: World): void {
  const question = eventsOf(world, 'stop').at(-1)!
  appendFileSync(world.journal, `${JSON.stringify({ ...question, at: 'merge', pr: 101, why: 'the owner merges PR #101' })}\n`)
}

describe('an approved brief releases only a hash stop', () => {
  it.each([
    { at: 'question', stand: () => {} },
    { at: 'merge', stand: standingMergeStop },
  ])('approved ladder card with a standing merge or question stop stays waits merge: $at', async ({ at, stand }) => {
    const world = newWorld([{ id: 1, kind: LADDER, who: 'shift', body: 'do 1 STUB-BRIEF-WRITE STUB-QUESTION STUB-NO-PR' }])
    await shiftOver(world, world.shift)
    stand(world)
    approve(world, 1)
    const runs = stubRuns(world, 1)
    const stops = eventsOf(world, 'stop').length
    expect(eventsOf(world, 'stop').at(-1)).toMatchObject({ task: '1', at })
    const rerun = await shiftOver(world, path.join(world.root, 'shift-2'))
    expect(rerun.out).toContain('[shift] parking: takes none')
    expect(rerun.out).toContain(`[shift] parking: leaves #1 (waits ${at})`)
    expect(rerun.steps).toBe(0)
    expect(stubRuns(world, 1)).toBe(runs)
    expect(eventsOf(world, 'stop')).toHaveLength(stops)
  })
})
