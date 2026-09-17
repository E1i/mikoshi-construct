import type { DiscoveryMarker } from '../src/manifest.js'
import type { Strategy } from '../src/materialize/strategies.js'
import type { PathClass, PathClassification } from '../src/sync/classify.js'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runInit } from '../src/commands/init.js'
import { applySync, printSyncApply, runSync, SYNC_APPLY_EXIT, syncApplyExit, syncApplyJson } from '../src/commands/sync/index.js'
import { DISCOVERY_MARKERS, MANIFEST_VERSION, markerFile, readManifest, sha256, writeManifest } from '../src/manifest.js'
import { BLOCK_BEGIN, BLOCK_END } from '../src/materialize/strategies.js'
import { isWritable, PATH_CLASSES } from '../src/sync/classify.js'
import { ownedSha, ownedText } from '../src/sync/ownership.js'
import { replay } from '../src/sync/replay.js'
import { planWrites } from '../src/sync/write.js'
import { createUi, silentWriter } from '../src/ui/console.js'
import { PLAIN_LORE } from '../src/ui/lore.js'
import { resolveTheme } from '../src/ui/theme.js'
import { VERSION } from '../src/version.js'

const FIXTURE = path.join(import.meta.dirname, 'fixtures/sync/materialized-by-0.1.0')
const MANIFEST = 'construct.json'
const MARKER_CARRYING_FILES = ['AGENTS.md', 'architecture/security-invariants.md', 'CLAUDE.md']
const EMOJI = /\p{Extended_Pictographic}/u
const LORE_VOCABULARY = ['GLITCH', 'FLATLINED', 'WRITE TRACE', 'WRITTEN', 'LEFT TO YOU', 'MATERIALIZED BY CONSTRUCT', 'Netrunner', 'ARASAKA']

function scratch(): string {
  return mkdtempSync(path.join(tmpdir(), 'construct-apply-'))
}

function frozenTree(): string {
  const dir = scratch()
  cpSync(path.join(FIXTURE, MANIFEST), path.join(dir, MANIFEST))
  cpSync(path.join(FIXTURE, 'AGENTS.md.frozen'), path.join(dir, 'AGENTS.md'))
  cpSync(path.join(FIXTURE, 'CLAUDE.md.frozen'), path.join(dir, 'CLAUDE.md'))
  mkdirSync(path.join(dir, 'architecture'), { recursive: true })
  cpSync(path.join(FIXTURE, 'security-invariants.md.frozen'), path.join(dir, 'architecture/security-invariants.md'))
  return dir
}

function frozenTreeWithTheVariantRecorded(): string {
  const dir = frozenTree()
  const manifest = readManifest(dir)!
  writeManifest(dir, { ...manifest, variants: { 'AGENTS.md': 'default', 'CLAUDE.md': 'existing' } })
  return dir
}

function filesIn(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => path.relative(root, path.join(entry.parentPath, entry.name)))
    .sort()
}

function treeDigest(root: string): Record<string, string> {
  return Object.fromEntries(filesIn(root).map(file => [file, sha256(readFileSync(path.join(root, file), 'utf8'))]))
}

function read(root: string, target: string): string {
  return readFileSync(path.join(root, target), 'utf8')
}

function markerBody(document: string, marker: string): string | null {
  const open = `<!-- construct:discover:${marker} -->`
  const close = `<!-- /construct:discover:${marker} -->`
  const start = document.indexOf(open)
  const end = document.indexOf(close)
  return start === -1 || end < start ? null : document.slice(start + open.length, end)
}

function markerBodies(root: string): Record<DiscoveryMarker, string | null> {
  const carried = MARKER_CARRYING_FILES.filter(file => existsSync(path.join(root, file))).map(file => read(root, file))
  return Object.fromEntries(DISCOVERY_MARKERS.map(marker => [
    marker,
    carried.map(document => markerBody(document, marker)).find(body => body != null) ?? null,
  ])) as Record<DiscoveryMarker, string | null>
}

function outsideTheBlock(content: string): [string, string] {
  return [content.slice(0, content.indexOf(BLOCK_BEGIN)), content.slice(content.indexOf(BLOCK_END) + BLOCK_END.length)]
}

function producedBy(root: string): Record<string, string> {
  return replay({ root, manifest: readManifest(root)!, version: VERSION }).produced
}

function packageJsonMissingAKey(root: string): string {
  const produced = JSON.parse(producedBy(root)['package.json']) as Record<string, unknown>
  const { scripts, ...withoutScripts } = produced
  expect(scripts).toBeDefined()
  const content = `${JSON.stringify(withoutScripts, null, 2)}\n`
  writeFileSync(path.join(root, 'package.json'), content)
  return content
}

describe('sync --apply over a tree whose discovery markers are filled', () => {
  it('carries the body of every discovery marker through byte for byte, and moves the block itself to what the templates produce', () => {
    const dir = frozenTreeWithTheVariantRecorded()
    const before = markerBodies(dir)
    const blockFile = 'AGENTS.md'
    const wasInTheTree = read(dir, blockFile)
    const produced = producedBy(dir)[blockFile]

    const result = applySync(dir, VERSION)!
    expect(result.written).toContain(blockFile)
    const after = markerBodies(dir)
    for (const marker of DISCOVERY_MARKERS)
      expect(after[marker], marker).toBe(before[marker])

    const withABodyInAFile = DISCOVERY_MARKERS.filter(marker => (before[marker] ?? '').trim() !== '')
    expect(withABodyInAFile).toHaveLength(DISCOVERY_MARKERS.length - 1)
    expect(before.composition).toBeNull()
    expect(markerFile('composition', readManifest(dir)!.vars.compositionDir)).toBe('architecture/composition')

    const nowInTheTree = read(dir, blockFile)
    expect(nowInTheTree).not.toBe(wasInTheTree)
    expect(ownedText(blockFile, nowInTheTree)).toBe(ownedText(blockFile, produced))
    expect(ownedText(blockFile, nowInTheTree)).not.toBe(ownedText(blockFile, wasInTheTree))
    expect(outsideTheBlock(nowInTheTree)).toEqual(outsideTheBlock(wasInTheTree))
  })

  it('writes a block target by substitution, so no byte outside the construct block moves', () => {
    const dir = frozenTreeWithTheVariantRecorded()
    const before = Object.fromEntries(['AGENTS.md', 'CLAUDE.md'].map(target => [target, read(dir, target)]))
    applySync(dir, VERSION)
    for (const [target, content] of Object.entries(before)) {
      expect(outsideTheBlock(read(dir, target)), target).toEqual(outsideTheBlock(content))
      expect(ownedText(target, read(dir, target)), target).toBe(ownedText(target, producedBy(dir)[target]))
    }
  })
})

describe('what sync plans to write', () => {
  const STRATEGY_TARGET: Record<Strategy, string> = {
    'create': 'architecture/principles.md',
    'merge-json': 'package.json',
    'append-block': 'AGENTS.md',
  }

  function blockDocument(body: string): string {
    return `# Mine\n\nprose\n\n${BLOCK_BEGIN}\n${body}\n${BLOCK_END}\n`
  }

  it('plans a write exactly where isWritable holds: add and update, create and append-block, never a merged target', () => {
    for (const value of PATH_CLASSES) {
      for (const [strategy, target] of Object.entries(STRATEGY_TARGET) as [Strategy, string][]) {
        const classification: PathClassification = { target, strategy, class: value, keys: [], writeEffect: null }
        const present = { [target]: strategy === 'append-block' ? blockDocument('old') : 'present' }
        const produced = { [target]: strategy === 'append-block' ? blockDocument('new') : 'produced' }
        const plan = planWrites({ classifications: [classification], present, produced })

        const writable = (value === 'add' || value === 'update') && strategy !== 'merge-json'
        expect(isWritable(classification), `${value} ${strategy}`).toBe(writable)
        expect(plan.writes.map(write => write.target), `${value} ${strategy}`).toEqual(writable ? [target] : [])
        expect(plan.refused.map(entry => entry.target), `${value} ${strategy}`).toEqual(writable || !['add', 'update'].includes(value) ? [] : [target])
      }
    }
  })

  it('leaves a package.json whose owned keys make it update unwritten, unchanged and unrecorded', () => {
    const dir = frozenTree()
    const content = packageJsonMissingAKey(dir)
    const classification = runSync(dir, VERSION)!.classifications.find(entry => entry.target === 'package.json')
    expect(classification?.strategy).toBe('merge-json')
    expect(classification?.class).toBe('update')

    const result = applySync(dir, VERSION)!
    expect(result.written).not.toContain('package.json')
    expect(result.refused.map(entry => entry.target)).toContain('package.json')
    expect(read(dir, 'package.json')).toBe(content)
    expect(readManifest(dir)!.sync?.files['package.json']).toBeUndefined()
  })
})

describe('what sync --apply never touches', () => {
  it('leaves every keep, conflict, removed, orphaned and foreign path byte-identical, path by path', () => {
    const dir = frozenTree()
    const manifest = readManifest(dir)!
    const evidence = replay({ root: dir, manifest, version: VERSION })

    const alreadyWhatTheTemplatesProduce = 'architecture/checklists.md'
    writeFileSync(path.join(dir, alreadyWhatTheTemplatesProduce), evidence.produced[alreadyWhatTheTemplatesProduce])
    const noTemplateProducesItAnyMore = 'README.md'
    expect(evidence.produced[noTemplateProducesItAnyMore]).toBeUndefined()
    writeManifest(dir, { ...manifest, files: { ...manifest.files, [noTemplateProducesItAnyMore]: 'a sha no template produces today' } })
    writeFileSync(path.join(dir, noTemplateProducesItAnyMore), 'the construct wrote this once; it is mine now\n')
    const neverOurs = 'src/owner-wrote-this.ts'
    mkdirSync(path.join(dir, 'src'), { recursive: true })
    writeFileSync(path.join(dir, neverOurs), 'export const mine = true\n')
    packageJsonMissingAKey(dir)

    const untouchable = runSync(dir, VERSION)!.classifications.filter(entry => !isWritable(entry))
    expect(new Set(untouchable.map(entry => entry.class))).toEqual(new Set<PathClass>(['keep', 'conflict', 'unknown', 'removed', 'orphaned', 'update']))
    expect(untouchable.some(entry => entry.target === neverOurs), 'a file no record and no template carries is not a path sync considers at all').toBe(false)
    const before = Object.fromEntries([...untouchable.map(entry => entry.target), neverOurs]
      .filter(target => existsSync(path.join(dir, target)))
      .map(target => [target, read(dir, target)]))
    expect(Object.keys(before).length).toBeGreaterThan(3)
    expect(before[neverOurs]).toBeDefined()

    applySync(dir, VERSION)
    for (const [target, content] of Object.entries(before))
      expect(read(dir, target), target).toBe(content)
    for (const entry of untouchable.filter(entry => entry.class === 'removed'))
      expect(existsSync(path.join(dir, entry.target)), entry.target).toBe(false)
  })

  it('deletes nothing: the tree afterwards is the tree before plus exactly the add paths it wrote', () => {
    const dir = frozenTree()
    const before = filesIn(dir)
    const added = runSync(dir, VERSION)!.classifications.filter(entry => entry.class === 'add').map(entry => entry.target)

    const result = applySync(dir, VERSION)!
    const after = filesIn(dir)
    expect(added.length).toBeGreaterThan(0)
    for (const file of before)
      expect(after, file).toContain(file)
    expect(after.filter(file => !before.includes(file))).toEqual([...added].sort())
    expect(result.written).toEqual(expect.arrayContaining(added))
  })
})

describe('what sync --apply records', () => {
  it('records the owned view of every path it wrote and leaves every other manifest field as it was', () => {
    const dir = frozenTree()
    const onDisk = JSON.parse(read(dir, MANIFEST)) as Record<string, unknown>
    const before = readManifest(dir)!

    const result = applySync(dir, VERSION)!
    const after = readManifest(dir)!

    expect(Object.keys(after.sync!.files).sort()).toEqual([...result.written].sort())
    for (const target of result.written)
      expect(after.sync!.files[target], target).toBe(ownedSha(target, read(dir, target)))
    expect(Date.parse(after.sync!.ranAt)).not.toBeNaN()
    expect(after.sync!.ranAt).toBe(result.ranAt)
    expect(after.sync!.fromVersion).toBe(before.construct)
    expect(after.sync!.toVersion).toBe(VERSION)

    expect(after.construct).toBe(before.construct)
    expect(after.createdAt).toBe(before.createdAt)
    expect(after.preset).toBe(before.preset)
    expect(after.ai).toBe(before.ai)
    expect(after.review).toEqual(before.review)
    expect(after.harness).toEqual(before.harness)
    expect(after.report).toEqual(before.report)
    expect(after.contracts).toEqual(before.contracts)
    expect(after.vars).toEqual(before.vars)
    expect(Object.keys(after.files)).toEqual(Object.keys(before.files))
    for (const [file, sha] of Object.entries(before.files))
      expect(after.files[file], file).toBe(sha)
    expect(after.discovery.baseSha).toBe(before.discovery.baseSha)
    expect(after.discovery.filledAt).toBe(before.discovery.filledAt)
    for (const marker of DISCOVERY_MARKERS)
      expect(after.discovery.markers[marker], marker).toEqual(before.discovery.markers[marker])
    expect({ ...after, sync: null }).toEqual(before)

    expect(onDisk.manifestVersion).toBeUndefined()
    expect(after.manifestVersion).toBe(MANIFEST_VERSION)
    expect(JSON.parse(read(dir, MANIFEST)).manifestVersion).toBe(MANIFEST_VERSION)
  })

  it('accumulates: a later run keeps what an earlier run recorded', async () => {
    const dir = scratch()
    await runInit(createUi(resolveTheme({ plain: true }), silentWriter), { dir, preset: 'node-backend', name: 'scratch', yes: true, dryRun: false })

    const written: string[] = []
    for (const target of ['architecture/principles.md', 'architecture/checklists.md']) {
      const manifest = readManifest(dir)!
      const { [target]: dropped, ...files } = manifest.files
      expect(dropped).toBeDefined()
      rmSync(path.join(dir, target))
      writeManifest(dir, { ...manifest, files })

      const result = applySync(dir, VERSION)!
      expect(result.written).toEqual([target])
      written.push(target)
      expect(Object.keys(readManifest(dir)!.sync!.files).sort()).toEqual([...written].sort())
    }
  })
})

describe('sync --apply twice', () => {
  it('reads back nothing to add or update, recreates no recorded path the tree does not carry, and writes nothing the second time', () => {
    const dir = frozenTree()
    const first = applySync(dir, VERSION)!
    expect(first.written.length).toBeGreaterThan(0)

    const afterwards = runSync(dir, VERSION)!
    expect(afterwards.counts.add).toBe(0)
    expect(afterwards.counts.update).toBe(0)
    const removed = afterwards.classifications.filter(entry => entry.class === 'removed').map(entry => entry.target)
    expect(removed).toContain('package.json')
    for (const target of removed)
      expect(existsSync(path.join(dir, target)), target).toBe(false)

    const tree = treeDigest(dir)
    const manifestBytes = read(dir, MANIFEST)
    const second = applySync(dir, VERSION)!
    expect(second.written).toEqual([])
    expect(read(dir, MANIFEST)).toBe(manifestBytes)
    expect(treeDigest(dir)).toEqual(tree)
  })
})

function renderApply(dir: string): { output: string, code: number } {
  const lines: string[] = []
  const ui = createUi(resolveTheme({ plain: true }), text => lines.push(text))
  const code = printSyncApply(ui, applySync(dir, VERSION))
  return { output: lines.join('').replaceAll(/\[[\d;]*m/g, ''), code }
}

describe('the apply report', () => {
  it('exits 0 when every pending path was written, 2 when a merged target was refused, and 1 without a construct.json', () => {
    expect(renderApply(frozenTree()).code).toBe(SYNC_APPLY_EXIT.written)

    const withAMergedTarget = frozenTree()
    packageJsonMissingAKey(withAMergedTarget)
    expect(renderApply(withAMergedTarget).code).toBe(SYNC_APPLY_EXIT.refused)

    const empty = scratch()
    expect(applySync(empty, VERSION)).toBeNull()
    expect(syncApplyExit(null)).toBe(SYNC_APPLY_EXIT.noManifest)
    expect(renderApply(empty).code).toBe(SYNC_APPLY_EXIT.noManifest)
    expect(filesIn(empty)).toEqual([])
  })

  it('names what it wrote, states the write effect a block target carries, and says a merged target is left to you', () => {
    const dir = frozenTreeWithTheVariantRecorded()
    packageJsonMissingAKey(dir)
    const { output } = renderApply(dir)

    expect(output).toContain('AGENTS.md')
    expect(output).toContain(PLAIN_LORE.syncWriteEffect['block-replaced-whole-discovery-bodies-carried-over'])
    expect(output).toContain('package.json')
    expect(output).toContain(PLAIN_LORE.syncMergedNotWritten)
    expect(output).toContain(PLAIN_LORE.syncApplyLeftToYou(1))
  })

  it('shows a path whose variant it cannot establish under a heading of its own, apart from what it refused', () => {
    const dir = frozenTree()
    packageJsonMissingAKey(dir)
    const lines = renderApply(dir).output.split('\n').map(line => line.trim())
    const unknownAt = lines.indexOf(PLAIN_LORE.syncApplyUnknown)
    const refusedAt = lines.indexOf(PLAIN_LORE.syncApplyRefused)

    expect(unknownAt).toBeGreaterThan(-1)
    expect(refusedAt).toBeGreaterThan(unknownAt)
    expect(lines.slice(unknownAt + 1, refusedAt).join(' ')).toContain('AGENTS.md')
    expect(lines.slice(unknownAt + 1, refusedAt).join(' ')).toContain(PLAIN_LORE.syncVariantUnknown('default'))
    expect(lines.slice(refusedAt + 1).join(' ')).toContain('package.json')
    expect(lines.slice(refusedAt + 1).join(' ')).not.toContain('AGENTS.md')
  })

  it('carries no emoji and no lore vocabulary with --plain', () => {
    const { output } = renderApply(frozenTree())
    expect(output).not.toMatch(EMOJI)
    for (const word of LORE_VOCABULARY)
      expect(output, word).not.toContain(word)
  })

  it('as json, carries the report plus what was written, what is pending and when the run happened', () => {
    const dir = frozenTree()
    packageJsonMissingAKey(dir)
    const result = applySync(dir, VERSION)!
    const json = syncApplyJson(result) as { fromVersion: string, toVersion: string, counts: Record<PathClass, number>, paths: unknown[], written: string[], pending: string[], ranAt: string }

    expect(json.fromVersion).toBe('0.1.0')
    expect(json.toVersion).toBe(VERSION)
    expect(Object.keys(json.counts).sort()).toEqual([...PATH_CLASSES].sort())
    expect(json.paths.length).toBeGreaterThan(0)
    expect(json.written).toEqual(result.written)
    expect(json.pending).toEqual(['package.json'])
    expect(Date.parse(json.ranAt)).not.toBeNaN()
    expect(JSON.stringify(json)).not.toContain(PLAIN_LORE.syncApplyTitle)
  })
})
