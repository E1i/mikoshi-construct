import type { PathClass } from '../src/sync/classify.js'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runInit } from '../src/commands/init.js'
import { applySync, printSync, runSync } from '../src/commands/sync/index.js'
import { MANIFEST_FILE, MANIFEST_VERSION, readManifest } from '../src/manifest.js'
import { BLOCK_END } from '../src/materialize/strategies.js'
import { ownedSha } from '../src/sync/ownership.js'
import { createUi, silentWriter } from '../src/ui/console.js'
import { PLAIN_LORE } from '../src/ui/lore.js'
import { resolveTheme } from '../src/ui/theme.js'
import { VERSION } from '../src/version.js'

const BLOCK_TARGET = 'AGENTS.md'
const WRITTEN_NAME = 'd4'
const CURRENT_NAME = 'mikoshi-construct'

function scratch(): string {
  return mkdtempSync(path.join(tmpdir(), 'construct-block-record-'))
}

async function initialised(name: string): Promise<string> {
  const dir = scratch()
  await runInit(createUi(resolveTheme({ plain: true }), silentWriter), { dir, preset: 'node-backend', name, yes: true, dryRun: false })
  return dir
}

function rawManifest(dir: string): Record<string, any> {
  return JSON.parse(readFileSync(path.join(dir, MANIFEST_FILE), 'utf8')) as Record<string, any>
}

function writeRaw(dir: string, raw: Record<string, unknown>): void {
  writeFileSync(path.join(dir, MANIFEST_FILE), `${JSON.stringify(raw, null, 2)}\n`)
}

function editRecordedName(dir: string, name: string): void {
  const raw = rawManifest(dir)
  raw.vars.projectName = name
  writeRaw(dir, raw)
}

function editBlockByHand(dir: string): void {
  const file = path.join(dir, BLOCK_TARGET)
  writeFileSync(file, readFileSync(file, 'utf8').replace(BLOCK_END, `A line the owner added.\n${BLOCK_END}`))
}

function classOf(dir: string, target = BLOCK_TARGET): PathClass | undefined {
  return runSync(dir, VERSION)?.classifications.find(entry => entry.target === target)?.class
}

function printed(dir: string): string[] {
  const chunks: string[] = []
  printSync(createUi(resolveTheme({ plain: true }), text => chunks.push(text)), runSync(dir, VERSION))
  return chunks.join('').split('\n').map(line => line.trim())
}

function listedUnder(lines: string[], heading: PathClass): string[] {
  const start = lines.findIndex(line => line.startsWith(`${heading} —`))
  if (start === -1)
    return []
  const end = lines.findIndex((line, index) => index > start && line === '')
  return lines.slice(start + 1, end === -1 ? undefined : end)
}

describe('a version 6 record carries the block it wrote and the vars it wrote with', () => {
  it('records the owned sha of each block and the vars snapshot at init, and a sync right after reads keep', async () => {
    const dir = await initialised(WRITTEN_NAME)
    const manifest = readManifest(dir)!
    const agents = readFileSync(path.join(dir, BLOCK_TARGET), 'utf8')

    expect(rawManifest(dir).manifestVersion).toBe(MANIFEST_VERSION)
    expect(MANIFEST_VERSION).toBe(6)
    expect(manifest.blocks[BLOCK_TARGET]).toEqual({ ownedSha: ownedSha(BLOCK_TARGET, agents), vars: manifest.vars })
    expect(Object.keys(manifest.blocks).sort()).toEqual(['.gitignore', 'AGENTS.md', 'CLAUDE.md'])
    expect(classOf(dir)).toBe('keep')
  })

  it('records the block and the vars again in the sync branch when sync --apply writes a block', async () => {
    const dir = await initialised(WRITTEN_NAME)
    expect(runSync(dir, '99.0.0')?.classifications.find(entry => entry.target === BLOCK_TARGET)?.class).toBe('template-moved-on')

    const applied = applySync(dir, '99.0.0')!
    expect(applied.written).toContain(BLOCK_TARGET)
    const manifest = readManifest(dir)!
    const agents = readFileSync(path.join(dir, BLOCK_TARGET), 'utf8')
    expect(manifest.sync?.blocks[BLOCK_TARGET]).toEqual({ ownedSha: ownedSha(BLOCK_TARGET, agents), vars: manifest.vars })
    expect(runSync(dir, '99.0.0')?.classifications.find(entry => entry.target === BLOCK_TARGET)?.class).toBe('keep')
  })
})

describe('sync tells an edited record from an edited block', () => {
  it('reads a block carrying the written projectName under a record that names another as record-vars-edited, and names AGENTS.md', async () => {
    const dir = await initialised(WRITTEN_NAME)
    editRecordedName(dir, CURRENT_NAME)

    expect(readFileSync(path.join(dir, BLOCK_TARGET), 'utf8')).toContain(`# ${WRITTEN_NAME}`)
    expect(classOf(dir)).toBe('record-vars-edited')
    expect(listedUnder(printed(dir), 'record-vars-edited')).toContain(BLOCK_TARGET)
  })

  it('reads the same repository as keep once the record carries the value the block was written with again', async () => {
    const dir = await initialised(WRITTEN_NAME)
    editRecordedName(dir, CURRENT_NAME)
    editRecordedName(dir, WRITTEN_NAME)

    expect(classOf(dir)).toBe('keep')
  })

  it('reads a hand-edited block as block-edited', async () => {
    const dir = await initialised(WRITTEN_NAME)
    editBlockByHand(dir)

    expect(classOf(dir)).toBe('block-edited')
    expect(listedUnder(printed(dir), 'block-edited')).toContain(BLOCK_TARGET)
  })

  it('reads a block edited by hand under a record whose vars were edited too as block-edited: the block is asked first', async () => {
    const dir = await initialised(WRITTEN_NAME)
    editBlockByHand(dir)
    editRecordedName(dir, CURRENT_NAME)

    expect(classOf(dir)).toBe('block-edited')
  })

  it('writes neither an edited block nor a block under an edited record', async () => {
    const dir = await initialised(WRITTEN_NAME)
    editBlockByHand(dir)
    const edited = await initialised(WRITTEN_NAME)
    editRecordedName(edited, CURRENT_NAME)

    for (const root of [dir, edited]) {
      const before = readFileSync(path.join(root, BLOCK_TARGET), 'utf8')
      expect(applySync(root, VERSION)?.written).not.toContain(BLOCK_TARGET)
      expect(readFileSync(path.join(root, BLOCK_TARGET), 'utf8')).toBe(before)
    }
  })
})

describe('a version 5 record predates the fields that would answer', () => {
  async function version5WithTheRecordEdited(): Promise<string> {
    const dir = await initialised(WRITTEN_NAME)
    const { blocks, variants, ...raw } = rawManifest(dir)
    expect(blocks).toBeDefined()
    expect(variants).toBeDefined()
    writeRaw(dir, { ...raw, manifestVersion: 5, vars: { ...raw.vars, projectName: CURRENT_NAME } })
    return dir
  }

  it('reads the block as unknown and says the record predates the fields', async () => {
    const dir = await version5WithTheRecordEdited()

    expect(readManifest(dir)?.blocks).toEqual({})
    expect(classOf(dir)).toBe('unknown')
    const unknown = listedUnder(printed(dir), 'unknown').find(line => line.startsWith(BLOCK_TARGET))
    expect(unknown).toContain(PLAIN_LORE.syncRecordPredatesBlockFields)
  })
})
