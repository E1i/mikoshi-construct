import type { SweepDeps } from '../../worktrees/sweep.js'
import type { World } from './fixtures/autopilot-world.js'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runShift } from '../../shift/shift.js'
import { runSweep } from '../../worktrees/sweep.js'
import { busMergesWhatIsHanded, captured, cardLine, depsOf, eventsOf, fakeGh, newWorld } from './fixtures/autopilot-world.js'

const OWNER = 'implement/runner/S/cheap/owner'

function sweepDeps(world: World, gh: (args: string[]) => string): SweepDeps {
  return {
    cwd: world.repo,
    handoffDir: world.handoff,
    git: (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe' }),
    gh,
    readJournal: file => existsSync(file) ? readFileSync(file, 'utf8') : null,
  }
}

function branches(world: World): string[] {
  return execFileSync('git', ['-C', world.repo, 'branch', '--format=%(refname:short)'], { encoding: 'utf8' }).split('\n').filter(line => line !== '')
}

describe('a shift sweeps the tree of its own card once it records that card\'s merge', () => {
  it('removes the merged card\'s tree and branch and keeps the tree of a card whose merge is the owner\'s', async () => {
    const world = newWorld([
      { id: 1, body: 'do 1 STUB-VERIFIED-run STUB-PR-101' },
      { id: 2, kind: OWNER, body: 'do 2 STUB-VERIFIED-run STUB-PR-102' },
    ])
    const fake = fakeGh({ 101: cardLine(1), 102: cardLine(2, OWNER) })
    const { gh } = fake
    const io = captured()
    const swept: string[] = []
    const sweep = (card: string): ReturnType<typeof runSweep> => {
      swept.push(card)
      return runSweep(['--apply', '--card', card], sweepDeps(world, gh))
    }
    await runShift([world.shift, '--parking', world.parking], depsOf(world, gh, io, { sweep, ...busMergesWhatIsHanded(fake, io) }))
    expect(eventsOf(world, 'merge').map(line => line.task)).toEqual(['1'])
    expect(swept).toEqual(['1'])
    expect(existsSync(path.join(world.root, 'mc-1'))).toBe(false)
    expect(existsSync(path.join(world.root, 'mc-2'))).toBe(true)
    expect(branches(world)).toEqual(['feat/2', 'main'])
    expect(io.out).toContain(`[worktrees:sweep] removed ${path.join(world.root, 'mc-1')} and branch feat/1: card #1 is merged`)
  })

  it('sweeps no tree a card of another shift holds, though its merge is recorded here', async () => {
    const world = newWorld([{ id: 1, body: 'do 1 STUB-VERIFIED-run STUB-PR-101' }])
    const fake = fakeGh({ 101: cardLine(1) })
    const { gh } = fake
    const swept: string[] = []
    const other = path.join(world.root, 'other-shift')
    const io = captured()
    await runShift([world.shift, '--parking', world.parking], depsOf(world, gh, io, {
      ...busMergesWhatIsHanded(fake, io),
      sweep: (card) => {
        swept.push(card)
        return { stdout: [], stderr: [], exitCode: 0 }
      },
      readJournal: file => existsSync(file) ? readFileSync(file, 'utf8').replaceAll(`"shift":"${world.shift}"`, `"shift":"${other}"`) : null,
    }))
    expect(eventsOf(world, 'merge').map(line => line.task)).toEqual(['1'])
    expect(swept).toEqual([])
  })
})
