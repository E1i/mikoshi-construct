import type { Ui } from '../src/ui/console.js'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { costReport } from '../src/commands/cost/index.js'
import { runDoctor } from '../src/commands/doctor/index.js'
import { modelPicture } from '../src/commands/graph.js'
import { runInit } from '../src/commands/init.js'
import { runSync } from '../src/commands/sync/index.js'
import { flatlineFor, reported } from '../src/failure.js'
import { MANIFEST_FILE, MANIFEST_VERSION, readManifest, upgradeManifest } from '../src/manifest.js'
import { RecordAheadOfReader } from '../src/record-ahead.js'
import { createUi, silentWriter } from '../src/ui/console.js'
import { LORE, PLAIN_LORE } from '../src/ui/lore.js'
import { resolveTheme } from '../src/ui/theme.js'
import { VERSION } from '../src/version.js'

const AHEAD = MANIFEST_VERSION + 1
const LEGACY = path.resolve(import.meta.dirname, 'fixtures/manifest/legacy-0.1.x')

function treeAheadOfThisBinary(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'construct-ahead-'))
  writeFileSync(path.join(dir, MANIFEST_FILE), `${JSON.stringify({
    manifestVersion: AHEAD,
    construct: '9.9.9',
    preset: 'node-backend',
    ai: 'claude',
    harness: { command: 'pnpm run quality' },
    vars: {},
    files: {},
    discovery: { somethingThisBinaryHasNeverSeen: true },
  }, null, 2)}\n`)
  return dir
}

function recorder(): { ui: Ui, lines: string[] } {
  const lines: string[] = []
  return { ui: createUi(resolveTheme({ plain: true }), line => lines.push(line)), lines }
}

describe('a manifest ahead of this binary is a state, not a crash', () => {
  it('refuses to normalise a manifestVersion it does not understand, rather than rewriting it down', () => {
    const raw = { manifestVersion: AHEAD, vars: {}, discovery: {} }

    expect(() => upgradeManifest(raw)).toThrow(RecordAheadOfReader)
    expect(raw.manifestVersion).toBe(AHEAD)
  })

  it('carries both versions on the error, so the reading can name them', () => {
    try {
      upgradeManifest({ manifestVersion: AHEAD, vars: {}, discovery: {} })
      expect.unreachable('upgradeManifest accepted a manifest from a later build')
    }
    catch (error) {
      expect(error).toBeInstanceOf(RecordAheadOfReader)
      expect((error as RecordAheadOfReader).found).toBe(AHEAD)
      expect((error as RecordAheadOfReader).understood).toBe(MANIFEST_VERSION)
    }
  })

  it('reaches the composition root from every command that reads the manifest', () => {
    const dir = treeAheadOfThisBinary()

    expect(() => readManifest(dir)).toThrow(RecordAheadOfReader)
    expect(() => runDoctor(dir)).toThrow(RecordAheadOfReader)
    expect(() => runSync(dir, VERSION)).toThrow(RecordAheadOfReader)
    expect(() => costReport(dir, { env: {} })).toThrow(RecordAheadOfReader)
  })

  it('leaves every file where it found it when init reads a manifest from a later build, so an older CLI cannot damage a newer repository', async () => {
    const dir = treeAheadOfThisBinary()
    const before = Object.fromEntries(readdirSync(dir).map(entry => [entry, readFileSync(path.join(dir, entry), 'utf8')]))
    expect(Object.keys(before)).toEqual([MANIFEST_FILE])

    await expect(runInit(createUi(resolveTheme({ plain: true }), silentWriter), { dir, preset: 'node-backend', name: 'ahead', yes: true, dryRun: false }))
      .rejects
      .toThrow(RecordAheadOfReader)

    expect(Object.fromEntries(readdirSync(dir).map(entry => [entry, readFileSync(path.join(dir, entry), 'utf8')]))).toEqual(before)
  })

  it('reads the manifest for cost only where the runtime is not already named by the environment', () => {
    const dir = treeAheadOfThisBinary()

    expect(() => costReport(dir, { env: { CLAUDECODE: '1' } })).not.toThrow()
    expect(() => costReport(dir, { env: {} })).toThrow(RecordAheadOfReader)
  })

  it('leaves graph alone, because the picture is drawn from the model and never reads the manifest', () => {
    expect(() => modelPicture(treeAheadOfThisBinary())).not.toThrow()
  })

  it('is reported as a named state with both versions and no stack trace', () => {
    const { ui, lines } = recorder()

    const failed = reported(ui, () => {
      readManifest(treeAheadOfThisBinary())
    })

    expect(failed).toBe(1)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain(String(AHEAD))
    expect(lines[0]).toContain(String(MANIFEST_VERSION))
    expect(lines[0]).not.toContain('    at ')
    expect(lines[0]).not.toContain('RecordAheadOfReader')
  })

  it('says the same thing in both vocabularies, and the plain one carries no lore', () => {
    expect(LORE.recordAhead(MANIFEST_FILE, 'manifestVersion', AHEAD, MANIFEST_VERSION)).toContain('upgrade the CLI')
    expect(PLAIN_LORE.recordAhead(MANIFEST_FILE, 'manifestVersion', AHEAD, MANIFEST_VERSION)).toContain('upgrade the CLI')
    expect(PLAIN_LORE.recordAhead(MANIFEST_FILE, 'manifestVersion', AHEAD, MANIFEST_VERSION)).not.toMatch(/RELIC|ENGRAM|BLACKWALL/)
  })

  it('reports any other failure as its own message, so the new state is not a catch-all', () => {
    const { ui, lines } = recorder()

    const failed = reported(ui, () => {
      throw new Error('the composition model is missing')
    })

    expect(failed).toBe(1)
    expect(lines[0]).toContain('the composition model is missing')
  })

  it('succeeds without reporting where nothing is wrong', () => {
    const { ui, lines } = recorder()

    expect(reported(ui, () => {})).toBe(0)
    expect(lines).toEqual([])
  })

  it('still reads a manifest at or below the version this binary understands', () => {
    const legacy = JSON.parse(readFileSync(path.join(LEGACY, 'construct.json'), 'utf8')) as { manifestVersion?: number }
    const upgraded = upgradeManifest(legacy)

    expect(upgraded.manifestVersion).toBe(MANIFEST_VERSION)
    expect(Object.values(upgraded.discovery.markers).every(marker => marker.authoredBy === 'unknown')).toBe(true)
  })

  it('names the error rather than formatting it, so a non-error value is still reported', () => {
    const { ui, lines } = recorder()

    flatlineFor(ui, 'a string thrown from somewhere')

    expect(lines[0]).toContain('a string thrown from somewhere')
  })
})
