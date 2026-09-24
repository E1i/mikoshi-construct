import type { SyncReport } from '../src/commands/sync/index.js'
import type { PathClass, PathClassification } from '../src/sync/classify.js'
import type { ThemeName } from '../src/ui/theme.js'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runInit } from '../src/commands/init.js'
import { printSync, runSync, SYNC_EXIT, SYNC_JSON_SCHEMA_VERSION, syncExit, syncJson } from '../src/commands/sync/index.js'
import { sha256 } from '../src/manifest.js'
import { BLOCK_REPLACED_WHOLE_DISCOVERY_BODIES_CARRIED_OVER, PATH_CLASSES } from '../src/sync/classify.js'
import { createUi, silentWriter } from '../src/ui/console.js'
import { LORE, PLAIN_LORE } from '../src/ui/lore.js'
import { resolveTheme } from '../src/ui/theme.js'
import { VERSION } from '../src/version.js'

const EMOJI = /\p{Extended_Pictographic}/u
const LORE_VOCABULARY = ['GLITCH', 'FLATLINED', 'REPLAY TRACE', 'PATH CLASSES', 'MATERIALIZED BY CONSTRUCT', 'Netrunner', 'ARASAKA']

function classified(target: string, value: PathClass, overrides: Partial<PathClassification> = {}): PathClassification {
  return { target, class: value, strategy: 'create', keys: [], writeEffect: null, ...overrides }
}

function report(classifications: PathClassification[], versions: [string, string] = ['0.1.0', VERSION]): SyncReport {
  const counts = Object.fromEntries(PATH_CLASSES.map(value => [value, 0])) as Record<PathClass, number>
  for (const entry of classifications)
    counts[entry.class] += 1
  return { fromVersion: versions[0], toVersion: versions[1], counts, classifications }
}

function render(value: SyncReport | null, theme: ThemeName = 'plain'): { output: string, code: number } {
  const lines: string[] = []
  const ui = createUi(resolveTheme({ plain: theme === 'plain', johnny: theme === 'johnny' }), text => lines.push(text))
  const code = printSync(ui, value)

  return { output: lines.join('').replaceAll(/\[[\d;]*m/g, ''), code }
}

function nonEmptyLines(output: string): string[] {
  return output.split('\n').filter(line => line.trim() !== '')
}

const EVERY_CLASS = report([
  classified('architecture/added.md', 'add'),
  classified('architecture/kept.md', 'keep'),
  classified('AGENTS.md', 'update', { strategy: 'append-block', writeEffect: BLOCK_REPLACED_WHOLE_DISCOVERY_BODIES_CARRIED_OVER }),
  classified('eslint.config.mjs', 'conflict'),
  classified('CLAUDE.md', 'unknown', { strategy: 'append-block', shape: 'existing' }),
  classified('architecture/gone.md', 'removed'),
  classified('README.md', 'orphaned'),
  classified('src/owner-wrote-this.ts', 'foreign'),
  classified('package.json', 'update', { strategy: 'merge-json', keys: [{ key: 'scripts.sync', class: 'add' }, { key: 'name', class: 'keep' }] }),
])

describe('the sync report', () => {
  it('counts every class that has paths, each beside what the class means', () => {
    const { output } = render(EVERY_CLASS)
    for (const value of PATH_CLASSES) {
      const counted = EVERY_CLASS.counts[value] > 0
      expect(output.includes(`\n  ${value.padEnd(10)}`), `${value} listed=${counted}`).toBe(counted)
      if (counted)
        expect(output).toMatch(new RegExp(`^\\s*${value}\\s+\\d+\\s+\\S`, 'm'))
    }
  })

  it('leaves a class with no paths out of the counts, so an empty class is not read as a finding', () => {
    const { output } = render({ ...EVERY_CLASS, counts: { ...EVERY_CLASS.counts, removed: 0, orphaned: 0, foreign: 0 } })
    for (const value of ['removed', 'orphaned', 'foreign'])
      expect(output.includes(`\n  ${value.padEnd(10)}`), value).toBe(false)
  })

  it('lists the paths a person must act on and counts keep and foreign without listing them', () => {
    const { output } = render(EVERY_CLASS)
    for (const target of ['architecture/added.md', 'AGENTS.md', 'eslint.config.mjs', 'CLAUDE.md', 'architecture/gone.md', 'README.md', 'package.json'])
      expect(output, target).toContain(target)
    expect(output).not.toContain('architecture/kept.md')
    expect(output).not.toContain('src/owner-wrote-this.ts')
  })

  it('reports a merge-json target by its keys and says merged files are not written in this version', () => {
    const { output } = render(EVERY_CLASS)
    expect(output).toContain('scripts.sync')
    expect(output).toContain(PLAIN_LORE.syncMergedNotWritten)
    expect(render(report([classified('architecture/added.md', 'add')])).output).not.toContain(PLAIN_LORE.syncMergedNotWritten)
  })

  it('prints the write effect the classification carries, so the command restates nothing', () => {
    const effect = PLAIN_LORE.syncWriteEffect[BLOCK_REPLACED_WHOLE_DISCOVERY_BODIES_CARRIED_OVER]
    expect(effect).toBeDefined()
    expect(LORE.syncWriteEffect[BLOCK_REPLACED_WHOLE_DISCOVERY_BODIES_CARRIED_OVER]).toBeDefined()
    expect(render(EVERY_CLASS).output).toContain(effect)
    expect(render(report([classified('AGENTS.md', 'keep', { strategy: 'append-block' })])).output).not.toContain(effect)
  })

  it('keeps a path whose variant it cannot establish apart from one the owner changed, each under its own reason', () => {
    const { output } = render(EVERY_CLASS)
    const sections = output.split('\n').map(line => line.trim())
    const unknownAt = sections.lastIndexOf(sections.filter(line => line.startsWith('unknown')).at(-1) ?? '')
    const conflictAt = sections.lastIndexOf(sections.filter(line => line.startsWith('conflict')).at(-1) ?? '')

    expect(unknownAt).toBeGreaterThan(0)
    expect(conflictAt).toBeGreaterThan(0)
    expect(unknownAt).not.toBe(conflictAt)
    expect(output).toContain(PLAIN_LORE.syncClassMeaning.unknown)
    expect(PLAIN_LORE.syncClassMeaning.unknown).not.toBe(PLAIN_LORE.syncClassMeaning.conflict)
    expect(output).toContain(PLAIN_LORE.syncVariantUnknown('existing'))
    expect(sections[unknownAt + 1]).toContain('CLAUDE.md')
    expect(sections[conflictAt + 1]).toContain('eslint.config.mjs')
  })

  it('leaves the exit code on 0 for a path whose variant is unknown, because there is nothing to apply', () => {
    expect(render(report([classified('CLAUDE.md', 'unknown', { strategy: 'append-block', shape: 'default' })])).code).toBe(SYNC_EXIT.upToDate)
  })

  it('opens with the version that materialized the repository against the version reading it, because that frames everything under it', () => {
    for (const theme of ['plain', 'arasaka', 'johnny'] as const) {
      const [, second] = nonEmptyLines(render(EVERY_CLASS, theme).output)
      expect(second, theme).toContain('0.1.0')
      expect(second, theme).toContain(VERSION)
    }
  })

  it('closes on what would happen rather than on what the report is about', () => {
    for (const theme of ['plain', 'arasaka', 'johnny'] as const) {
      const last = nonEmptyLines(render(EVERY_CLASS, theme).output).at(-1) ?? ''
      expect(last, theme).not.toContain('0.1.0')
      expect(last.toLowerCase(), theme).toContain('written')
    }
  })

  it('exits 0 with nothing to write, 2 when add or update has entries, and 1 without a manifest', () => {
    expect(render(report([classified('architecture/kept.md', 'keep')])).code).toBe(SYNC_EXIT.upToDate)
    expect(render(report([classified('a.md', 'add')])).code).toBe(SYNC_EXIT.pending)
    expect(render(report([classified('a.md', 'update')])).code).toBe(SYNC_EXIT.pending)
    expect(render(null).code).toBe(SYNC_EXIT.noManifest)
    expect(SYNC_EXIT.pending).not.toBe(SYNC_EXIT.upToDate)
  })

  it('is not moved off 0 by a conflict, a removal or an orphan', () => {
    for (const value of ['conflict', 'unknown', 'removed', 'orphaned', 'foreign'] as const)
      expect(render(report([classified('x', value)])).code, value).toBe(SYNC_EXIT.upToDate)
  })

  it('carries no emoji and no lore vocabulary with --plain', () => {
    const { output } = render(EVERY_CLASS)
    expect(output).not.toMatch(EMOJI)
    for (const word of LORE_VOCABULARY)
      expect(output).not.toContain(word)
    expect(render(null).output).not.toMatch(EMOJI)
  })
})

describe('the sync report as json', () => {
  it('carries both versions, the counts and every classified path with its strategy and write effect', () => {
    const json = syncJson(EVERY_CLASS) as {
      schemaVersion: number
      fromVersion: string
      toVersion: string
      counts: Record<PathClass, number>
      paths: Array<{ target: string, class: PathClass, strategy: string, keys?: unknown[], writeEffect?: string }>
    }
    expect(json.schemaVersion).toBe(SYNC_JSON_SCHEMA_VERSION)
    expect(json.fromVersion).toBe('0.1.0')
    expect(json.toVersion).toBe(VERSION)
    expect(Object.keys(json.counts).sort()).toEqual([...PATH_CLASSES].sort())
    expect(json.paths).toHaveLength(EVERY_CLASS.classifications.length)
    expect(json.paths.map(entry => entry.target)).toContain('architecture/kept.md')

    const block = json.paths.find(entry => entry.target === 'AGENTS.md')
    expect(block?.strategy).toBe('append-block')
    expect(block?.writeEffect).toBe(BLOCK_REPLACED_WHOLE_DISCOVERY_BODIES_CARRIED_OVER)
    expect(json.paths.find(entry => entry.target === 'package.json')?.keys).toHaveLength(2)
    expect(json.paths.find(entry => entry.target === 'architecture/added.md')).not.toHaveProperty('writeEffect')
    expect(JSON.stringify(json)).not.toContain(PLAIN_LORE.syncMergedNotWritten)
  })
})

function treeDigest(root: string): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map((entry) => {
      const file = path.relative(root, path.join(entry.parentPath, entry.name))
      return `${file}:${sha256(readFileSync(path.join(root, file), 'utf8'))}`
    })
    .sort()
}

describe('sync against a repository it just materialized', () => {
  it('prints the same report twice and leaves the tree byte-identical', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'construct-sync-'))
    const silent = createUi(resolveTheme({ plain: true }), silentWriter)
    await runInit(silent, { dir, preset: 'node-backend', name: 'scratch', yes: true, dryRun: false })

    const before = treeDigest(dir)
    const first = render(runSync(dir, VERSION))
    const afterFirst = treeDigest(dir)
    const second = render(runSync(dir, VERSION))

    expect(first.output).toBe(second.output)
    expect(first.code).toBe(second.code)
    expect(afterFirst).toEqual(before)
    expect(treeDigest(dir)).toEqual(before)
    expect(first.code).toBe(SYNC_EXIT.upToDate)
    expect(JSON.stringify(syncJson(runSync(dir, VERSION)!))).toBe(JSON.stringify(syncJson(runSync(dir, VERSION)!)))
  })

  it('reads no construct.json as a report of its own', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'construct-sync-empty-'))
    expect(runSync(dir, VERSION)).toBeNull()
    expect(syncExit(null)).toBe(SYNC_EXIT.noManifest)
  })
})
