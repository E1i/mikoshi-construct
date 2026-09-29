import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runDoctor } from '../src/commands/doctor/index.js'
import { runInit } from '../src/commands/init.js'
import { applySync, runSync, SYNC_EXIT, syncExit } from '../src/commands/sync/index.js'
import { readManifest, recordedShas, writeManifest } from '../src/manifest.js'
import { SUCCESSORS } from '../src/presets/index.js'
import { ownedSha } from '../src/sync/ownership.js'
import { createUi, silentWriter } from '../src/ui/console.js'
import { resolveTheme } from '../src/ui/theme.js'
import { VERSION } from '../src/version.js'

const [PREDECESSOR, SUCCESSOR] = Object.entries(SUCCESSORS)[0]!

const worlds: string[] = []

afterEach(() => {
  for (const dir of worlds.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

async function materializedUnderTheOldName(): Promise<{ dir: string, ladder: string }> {
  const dir = mkdtempSync(path.join(tmpdir(), 'construct-succession-'))
  worlds.push(dir)
  await runInit(createUi(resolveTheme({ plain: true }), silentWriter), { dir, preset: 'node-backend', name: 'scratch', yes: true, dryRun: false })
  const ladder = readFileSync(path.join(dir, SUCCESSOR), 'utf8')
  renameSync(path.join(dir, SUCCESSOR), path.join(dir, PREDECESSOR))
  const manifest = readManifest(dir)!
  const { [SUCCESSOR]: _successor, ...files } = manifest.files
  writeManifest(dir, { ...manifest, files: { ...files, [PREDECESSOR]: ownedSha(PREDECESSOR, ladder) } })
  return { dir, ladder }
}

describe('sync over a repository materialized when the ladder script was still .mjs', () => {
  it('removes the unchanged .mjs by its record, writes the new path, and leaves nothing pending', async () => {
    const { dir, ladder } = await materializedUnderTheOldName()

    const result = applySync(dir, VERSION)!

    expect(result.retired).toEqual([PREDECESSOR])
    expect(result.written).toContain(SUCCESSOR)
    expect(existsSync(path.join(dir, PREDECESSOR))).toBe(false)
    expect(readFileSync(path.join(dir, SUCCESSOR), 'utf8')).toBe(ladder)
    const recorded = recordedShas(readManifest(dir)!)
    expect(recorded[SUCCESSOR]).toBeDefined()
    expect(recorded[PREDECESSOR]).toBeUndefined()
    expect(syncExit(runSync(dir, VERSION))).toBe(SYNC_EXIT.upToDate)
  })

  it('never lays the two side by side: an edited .mjs stays, the new path is not written, and both are left to the owner', async () => {
    const { dir } = await materializedUnderTheOldName()
    writeFileSync(path.join(dir, PREDECESSOR), 'return { edited: true }\n')

    const result = applySync(dir, VERSION)!

    expect(result.retired).toEqual([])
    expect(result.written).not.toContain(SUCCESSOR)
    expect(existsSync(path.join(dir, PREDECESSOR))).toBe(true)
    expect(existsSync(path.join(dir, SUCCESSOR))).toBe(false)
    const classes = Object.fromEntries(result.report.classifications.map(entry => [entry.target, entry.class]))
    expect([classes[PREDECESSOR], classes[SUCCESSOR]]).toEqual(['conflict', 'conflict'])
  })
})

describe('doctor over a repository whose owner moved the ladder script by hand', () => {
  it('reads a recorded .mjs gone from disk, with its successor present, as moved and not missing', async () => {
    const { dir } = await materializedUnderTheOldName()
    renameSync(path.join(dir, PREDECESSOR), path.join(dir, SUCCESSOR))

    const result = runDoctor(dir, VERSION)

    expect(result != null && 'missingFiles' in result).toBe(true)
    if (result == null || !('missingFiles' in result))
      return
    expect(result.missingFiles).toEqual([])
    expect(result.movedFiles).toEqual([PREDECESSOR])
  })

  it('still reads a recorded .mjs gone from disk, with no successor either, as missing', async () => {
    const { dir } = await materializedUnderTheOldName()
    rmSync(path.join(dir, PREDECESSOR))

    const result = runDoctor(dir, VERSION)

    if (result == null || !('missingFiles' in result))
      throw new Error('doctor read no manifest')
    expect(result.missingFiles).toEqual([PREDECESSOR])
    expect(result.movedFiles).toEqual([])
  })
})
