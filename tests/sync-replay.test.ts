import type { Manifest } from '../src/manifest.js'
import type { PathClassification } from '../src/sync/classify.js'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runInit } from '../src/commands/init.js'
import { readManifest, recordedShas, upgradeManifest } from '../src/manifest.js'
import { replay } from '../src/sync/replay.js'
import { createUi, silentWriter } from '../src/ui/console.js'
import { resolveTheme } from '../src/ui/theme.js'
import { VERSION } from '../src/version.js'

const ui = createUi(resolveTheme({ plain: true }), silentWriter)

const REPOSITORY = path.resolve(import.meta.dirname, '..')
const MATERIALIZED_BY_0_1_0 = path.join(import.meta.dirname, 'fixtures/sync/materialized-by-0.1.0/construct.json')

function frozenManifest(): Manifest {
  return upgradeManifest(JSON.parse(readFileSync(MATERIALIZED_BY_0_1_0, 'utf8')))
}

function replayFrozen(manifest: Manifest = frozenManifest()): PathClassification[] {
  return replay({ root: REPOSITORY, manifest, version: VERSION }).classifications
}

function at(classifications: PathClassification[], target: string): PathClassification | undefined {
  return classifications.find(entry => entry.target === target)
}

function ofClass(classifications: PathClassification[], value: PathClassification['class']): string[] {
  return classifications.filter(entry => entry.class === value).map(entry => entry.target)
}

function scratch(): string {
  return mkdtempSync(path.join(tmpdir(), 'construct-replay-'))
}

async function materialized(dir: string): Promise<Manifest> {
  await runInit(ui, { dir, preset: 'node-backend', name: 'scratch', yes: true, dryRun: false })
  return readManifest(dir)!
}

describe('replaying today\'s templates against the repository construct 0.1.0 materialized', () => {
  it('reads the version the manifest recorded and the version of the running CLI', () => {
    const report = replay({ root: REPOSITORY, manifest: frozenManifest(), version: VERSION })
    expect(report.fromVersion).toBe('0.1.0')
    expect(report.toVersion).toBe(VERSION)
    expect(report.fromVersion).not.toBe(report.toVersion)
  })

  it('classifies a recorded path as anything but add, and every path exactly once', () => {
    const classifications = replayFrozen()
    const recorded = recordedShas(frozenManifest())
    expect(classifications.length).toBeGreaterThan(0)
    expect(new Set(classifications.map(entry => entry.target)).size).toBe(classifications.length)
    for (const entry of classifications.filter(entry => recorded[entry.target] != null))
      expect(entry.class, entry.target).not.toBe('add')
  })

  it('reads the files the tree already carried when init ran, which it skipped and never recorded, as conflict', () => {
    const classifications = replayFrozen()
    const recorded = recordedShas(frozenManifest())
    for (const target of ['.editorconfig', 'eslint.config.mjs', 'pnpm-workspace.yaml', 'tsconfig.json', 'vitest.config.ts']) {
      expect(recorded[target], target).toBeUndefined()
      expect(at(classifications, target)?.class, target).toBe('conflict')
    }
  })

  it('reads a path today\'s templates produce that neither the record nor the tree carries as add', async () => {
    const onTheRealReplay = ofClass(replayFrozen(), 'add')
    const recorded = recordedShas(frozenManifest())
    for (const target of onTheRealReplay)
      expect(recorded[target], target).toBeUndefined()

    const dir = scratch()
    const manifest = await materialized(dir)
    const dropped = 'architecture/principles.md'
    rmSync(path.join(dir, dropped))
    const files = { ...manifest.files }
    delete files[dropped]
    const classifications = replay({ root: dir, manifest: { ...manifest, files }, version: VERSION }).classifications
    expect(at(classifications, dropped)?.class).toBe('add')
  })

  it('reads a recorded path today\'s templates no longer produce as orphaned', () => {
    const recorded = recordedShas(frozenManifest())
    for (const target of ofClass(replayFrozen(), 'orphaned'))
      expect(recorded[target], target).toBeDefined()

    const manifest = frozenManifest()
    const writtenByAGroupNoPresetCarriesAnyMore = 'README.md'
    const classifications = replayFrozen({
      ...manifest,
      files: { ...manifest.files, [writtenByAGroupNoPresetCarriesAnyMore]: 'a sha no template produces today' },
    })
    expect(at(classifications, writtenByAGroupNoPresetCarriesAnyMore)?.class).toBe('orphaned')
  })

  it('reads a recorded path the tree no longer carries as removed', () => {
    const manifest = frozenManifest()
    const deletedByTheOwner = 'architecture/there-is-no-such-file.md'
    const classifications = replayFrozen({
      ...manifest,
      files: { ...manifest.files, [deletedByTheOwner]: 'a sha of a file nobody kept' },
    })
    expect(at(classifications, deletedByTheOwner)?.class).toBe('removed')
  })
})

describe('the replay renders with the variables the manifest recorded', () => {
  it('stops and names every variable the manifest does not carry, and how to supply it', () => {
    const manifest = frozenManifest()
    const { nodeMajor, projectName, ...carried } = manifest.vars
    expect(nodeMajor).toBeDefined()
    expect(projectName).toBeDefined()

    let message = ''
    try {
      replayFrozen({ ...manifest, vars: carried })
    }
    catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain('nodeMajor')
    expect(message).toContain('projectName')
    expect(message).toContain('construct.json')
    expect(message).toContain('"vars"')
  })

  it('takes constructVersion from the running CLI and never from the record', async () => {
    const dir = scratch()
    const manifest = await materialized(dir)
    expect(manifest.vars.constructVersion).toBe(VERSION)

    const stamped = replay({ root: dir, manifest, version: '99.0.0' }).classifications.filter(entry => entry.class !== 'keep')
    expect(stamped.map(entry => entry.target)).toEqual(['AGENTS.md'])
    expect(stamped[0].class).toBe('update')
    expect(readFileSync(path.join(dir, 'AGENTS.md'), 'utf8')).toContain(`v${VERSION}`)
  })
})

describe('a replay over a tree that is already what the templates produce', () => {
  it('reports every path as keep, sample code included, and writes nothing', async () => {
    const dir = scratch()
    const manifest = await materialized(dir)
    const before = readManifest(dir)

    const classifications = replay({ root: dir, manifest, version: VERSION }).classifications
    expect(classifications.length).toBeGreaterThan(0)
    expect(ofClass(classifications, 'keep')).toEqual(classifications.map(entry => entry.target))
    expect(at(classifications, 'src/app.ts')?.class).toBe('keep')
    expect(readManifest(dir)).toEqual(before)
  })

  it('never proposes sample code the repository was too full to receive', async () => {
    const dir = scratch()
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'already-a-repository' }))
    const manifest = await materialized(dir)

    const classifications = replay({ root: dir, manifest, version: VERSION }).classifications
    expect(at(classifications, 'src/app.ts')).toBeUndefined()
    expect(ofClass(classifications, 'add')).toEqual([])
  })
})
