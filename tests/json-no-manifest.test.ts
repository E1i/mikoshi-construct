import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { DOCTOR_EXIT, DOCTOR_JSON_SCHEMA_VERSION } from '../src/commands/doctor/index.js'
import { SOULKILL_JSON_SCHEMA_VERSION } from '../src/commands/soulkill.js'
import { SYNC_APPLY_EXIT, SYNC_EXIT, SYNC_JSON_SCHEMA_VERSION } from '../src/commands/sync/index.js'
import { runCli } from './cli-process.js'

function emptyWorld(): { dir: string, home: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'construct-no-manifest-'))
  const world = { dir: path.join(root, 'repo'), home: path.join(root, 'home') }
  mkdirSync(world.dir)
  mkdirSync(world.home)
  return world
}

describe.concurrent('--json with no construct.json prints an object naming the state, never null, and keeps its exit code', () => {
  it.each([
    { args: ['doctor', '--json'], schemaVersion: DOCTOR_JSON_SCHEMA_VERSION, exit: DOCTOR_EXIT.noManifest },
    { args: ['sync', '--json'], schemaVersion: SYNC_JSON_SCHEMA_VERSION, exit: SYNC_EXIT.noManifest },
    { args: ['sync', '--apply', '--json'], schemaVersion: SYNC_JSON_SCHEMA_VERSION, exit: SYNC_APPLY_EXIT.noManifest },
  ])('$args', async ({ args, schemaVersion, exit }) => {
    const world = emptyWorld()
    const run = await runCli([...args, '--dir', world.dir], world.home)
    expect(JSON.parse(run.stdout)).toEqual({ schemaVersion, state: 'no-manifest' })
    expect(run.status).toBe(exit)
  })

  it('soulkill --json carries its schemaVersion beside the detected facts', async () => {
    const world = emptyWorld()
    const run = await runCli(['soulkill', '--json', '--dir', world.dir], world.home)
    expect(JSON.parse(run.stdout)).toMatchObject({ schemaVersion: SOULKILL_JSON_SCHEMA_VERSION, dir: path.resolve(world.dir) })
  })
})
