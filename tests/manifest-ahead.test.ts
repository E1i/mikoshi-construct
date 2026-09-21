import type { Ui } from '../src/ui/console.js'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { costReport } from '../src/commands/cost/index.js'
import { runDoctor } from '../src/commands/doctor/index.js'
import { modelPicture } from '../src/commands/graph.js'
import { runSync } from '../src/commands/sync/index.js'
import { flatlineFor, reported } from '../src/failure.js'
import { MANIFEST_FILE, MANIFEST_VERSION, ManifestAheadOfReader, readManifest, upgradeManifest } from '../src/manifest.js'
import { createUi } from '../src/ui/console.js'
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

    expect(() => upgradeManifest(raw)).toThrow(ManifestAheadOfReader)
    expect(raw.manifestVersion).toBe(AHEAD)
  })

  it('carries both versions on the error, so the reading can name them', () => {
    try {
      upgradeManifest({ manifestVersion: AHEAD, vars: {}, discovery: {} })
      expect.unreachable('upgradeManifest accepted a manifest from a later build')
    }
    catch (error) {
      expect(error).toBeInstanceOf(ManifestAheadOfReader)
      expect((error as ManifestAheadOfReader).found).toBe(AHEAD)
      expect((error as ManifestAheadOfReader).understood).toBe(MANIFEST_VERSION)
    }
  })

  it('reaches the composition root from every command that reads the manifest', () => {
    const dir = treeAheadOfThisBinary()

    expect(() => readManifest(dir)).toThrow(ManifestAheadOfReader)
    expect(() => runDoctor(dir)).toThrow(ManifestAheadOfReader)
    expect(() => runSync(dir, VERSION)).toThrow(ManifestAheadOfReader)
    expect(() => costReport(dir, { env: {} })).toThrow(ManifestAheadOfReader)
  })

  it('reads the manifest for cost only where the runtime is not already named by the environment', () => {
    const dir = treeAheadOfThisBinary()

    expect(() => costReport(dir, { env: { CLAUDECODE: '1' } })).not.toThrow()
    expect(() => costReport(dir, { env: {} })).toThrow(ManifestAheadOfReader)
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
    expect(lines[0]).not.toContain('ManifestAheadOfReader')
  })

  it('says the same thing in both vocabularies, and the plain one carries no lore', () => {
    expect(LORE.manifestAhead(AHEAD, MANIFEST_VERSION)).toContain('upgrade the CLI')
    expect(PLAIN_LORE.manifestAhead(AHEAD, MANIFEST_VERSION)).toContain('upgrade the CLI')
    expect(PLAIN_LORE.manifestAhead(AHEAD, MANIFEST_VERSION)).not.toMatch(/RELIC|ENGRAM|BLACKWALL/)
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
