import type { DoctorResult } from '../src/commands/doctor/index.js'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { printDoctor, runDoctor } from '../src/commands/doctor/index.js'
import { runInit } from '../src/commands/init.js'
import { applySync } from '../src/commands/sync/index.js'
import { readManifest, writeManifest } from '../src/manifest.js'
import { FACTORY_MANIFEST } from '../src/materialize/factory-manifest.js'
import { createUi, silentWriter } from '../src/ui/console.js'
import { PLAIN_LORE } from '../src/ui/lore.js'
import { resolveTheme } from '../src/ui/theme.js'
import { VERSION } from '../src/version.js'

const UNRECORDED = '.claude/agents/brief.md'

async function initialised(ai: 'claude' | 'cursor'): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), 'construct-doctor-factory-'))
  mkdirSync(path.join(dir, '.git'))
  const ui = createUi(resolveTheme({ plain: true }), silentWriter)
  await runInit(ui, { dir, preset: 'node-backend', ai, yes: true, dryRun: false, env: {}, home: mkdtempSync(path.join(tmpdir(), 'construct-home-')) })
  return dir
}

function withoutUnrecorded(dir: string, target: string): void {
  const manifest = readManifest(dir)!
  const files = { ...manifest.files }
  delete files[target]
  rmSync(path.join(dir, target), { force: true })
  writeManifest(dir, { ...manifest, files })
}

function doctor(dir: string): DoctorResult {
  return runDoctor(dir, VERSION) as DoctorResult
}

function printed(result: DoctorResult): string {
  const lines: string[] = []
  printDoctor(createUi(resolveTheme({ plain: true }), (text: string) => {
    lines.push(text)
  }), result)
  return lines.join('')
}

describe('doctor reads the tree against the factory manifest', () => {
  it('a fresh init has no factory file missing', async () => {
    const dir = await initialised('claude')
    const factory = new Set(FACTORY_MANIFEST)
    expect(doctor(dir).missingFiles.filter(file => factory.has(file))).toEqual([])
  })

  it('goes red on a factory file the record never carried, and names sync --apply', async () => {
    const dir = await initialised('claude')
    withoutUnrecorded(dir, UNRECORDED)
    const result = doctor(dir)
    expect(result.ok).toBe(false)
    expect(result.missingFiles).toContain(UNRECORDED)
    expect(printed(result)).toContain(PLAIN_LORE.factoryFilesMissing([UNRECORDED]))
  })

  it('is no longer red on it after construct sync --apply', async () => {
    const dir = await initialised('claude')
    withoutUnrecorded(dir, UNRECORDED)
    applySync(dir, VERSION)
    expect(doctor(dir).missingFiles).not.toContain(UNRECORDED)
  })

  it('reads a repository carrying none of the factory files as not driven by the factory, and not red for it', async () => {
    const dir = await initialised('claude')
    for (const target of FACTORY_MANIFEST)
      withoutUnrecorded(dir, target)
    expect(doctor(dir).missingFiles).toEqual([])
  })

  it('reads factory paths the repository holds as its own, with none of them recorded, as not driven by the factory', async () => {
    const dir = await initialised('claude')
    const manifest = readManifest(dir)!
    const files = Object.fromEntries(Object.entries(manifest.files).filter(([file]) => !FACTORY_MANIFEST.includes(file)))
    writeManifest(dir, { ...manifest, files })
    rmSync(path.join(dir, UNRECORDED), { force: true })
    expect(doctor(dir).missingFiles).toEqual([])
  })

  it('owes nothing to the factory in a repository without the Claude Code runtime', async () => {
    const dir = await initialised('cursor')
    const factory = new Set(FACTORY_MANIFEST)
    expect(doctor(dir).missingFiles.filter(file => factory.has(file))).toEqual([])
  })
})
