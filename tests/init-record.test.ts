import type { Manifest } from '../src/manifest.js'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runInit } from '../src/commands/init.js'
import { factsTheRepositoryEstablishes } from '../src/detect/facts.js'
import { readManifest, sha256 } from '../src/manifest.js'
import { replay } from '../src/sync/replay.js'
import { createUi, silentWriter } from '../src/ui/console.js'
import { resolveTheme } from '../src/ui/theme.js'
import { VERSION } from '../src/version.js'

function scratch(): string {
  return mkdtempSync(path.join(tmpdir(), 'construct-init-record-'))
}

async function init(dir: string, write = silentWriter, name = 'scratch'): Promise<string[]> {
  const result = await runInit(createUi(resolveTheme({ plain: true }), write), { dir, preset: 'node-backend', name, yes: true, dryRun: false })
  return result.written
}

function manifestOf(dir: string): Manifest {
  return readManifest(dir)!
}

function classificationMap(dir: string): Record<string, string> {
  const report = replay({ root: dir, manifest: manifestOf(dir), version: VERSION, facts: factsTheRepositoryEstablishes(dir) })
  return Object.fromEntries(report.classifications.map(entry => [entry.target, entry.class]))
}

function nextStepIn(lines: string[]): string | undefined {
  return lines.join('').split('\n').find(text => text.includes('Next: '))
}

describe('a second construct init adds to the record it found', () => {
  it('keeps every path the first run recorded, rewrites only what this run wrote, and leaves the first run\'s identity untouched', async () => {
    const dir = scratch()
    await init(dir)
    const first = manifestOf(dir)

    const written = await init(dir)
    const second = manifestOf(dir)

    for (const target of Object.keys(first.files))
      expect(Object.keys(second.files), target).toContain(target)

    for (const [target, sha] of Object.entries(second.files)) {
      if (written.includes(target))
        expect(sha, target).toBe(sha256(readFileSync(path.join(dir, target), 'utf8')))
      else
        expect(sha, target).toBe(first.files[target])
    }

    for (const [target, variant] of Object.entries(first.variants)) {
      if (!written.includes(target))
        expect(second.variants[target], target).toBe(variant)
    }
    expect(Object.keys(second.variants)).toEqual(expect.arrayContaining(Object.keys(first.variants)))

    expect(second.construct).toBe(first.construct)
    expect(second.createdAt).toBe(first.createdAt)
    expect(second.discovery).toEqual(first.discovery)
    expect(second.sync).toEqual(first.sync)
  })

  it('leaves the classification of every path exactly where the first run left it', async () => {
    const dir = scratch()
    await init(dir)
    const afterFirst = classificationMap(dir)

    await init(dir)
    const afterSecond = classificationMap(dir)

    expect(afterSecond).toEqual(afterFirst)
  })

  it('reports how many records it carried over and how many it added, and says nothing when there was no record', async () => {
    const dir = scratch()
    const firstRun: string[] = []
    await init(dir, text => firstRun.push(text))
    const recorded = manifestOf(dir).files

    const secondRun: string[] = []
    const written = await init(dir, text => secondRun.push(text))
    const carriedOver = Object.keys(recorded).filter(target => !written.includes(target)).length
    const added = written.filter(target => recorded[target] == null).length

    const line = secondRun.join('').split('\n').find(text => text.toLowerCase().includes('carried over'))
    expect(line).toBeDefined()
    expect(line).toContain(String(carriedOver))
    expect(line).toContain(`added ${added}`)
    expect(firstRun.join('').toLowerCase()).not.toContain('carried over')
  })
  it('reports the count before the list of paths, so a second run is readable as a no-op before the wall of text', async () => {
    const dir = scratch()
    await init(dir)

    const rerun: string[] = []
    await init(dir, text => rerun.push(text))
    const lines = rerun.join('').split('\n')
    const count = lines.findIndex(text => text.toLowerCase().includes('carried over'))
    const firstPath = lines.findIndex(text => /^\s+[+~=] /.test(text))

    expect(count).toBeGreaterThanOrEqual(0)
    expect(firstPath).toBeGreaterThanOrEqual(0)
    expect(count).toBeLessThan(firstPath)
  })

  it('names every variable whose value this run changed, with both values, and stays quiet when none did', async () => {
    const dir = scratch()
    await init(dir)
    const recorded = manifestOf(dir).vars.projectName

    const rerun: string[] = []
    await init(dir, text => rerun.push(text), 'renamed')
    const line = rerun.join('').split('\n').find(text => text.includes('projectName'))
    expect(line).toBeDefined()
    expect(line).toContain(recorded)
    expect(line).toContain('renamed')

    const unchanged: string[] = []
    await init(dir, text => unchanged.push(text), 'renamed')
    expect(unchanged.join('')).not.toContain('projectName')
  })

  it('names install and the harness where it wrote a manifest, nothing at all where the run changed no file, and the harness alone where it changed one that declares no dependency', async () => {
    const dir = scratch()

    const first: string[] = []
    await init(dir, text => first.push(text))
    expect(nextStepIn(first)).toContain('pnpm install && pnpm run quality')

    const unchanged: string[] = []
    await init(dir, text => unchanged.push(text))
    expect(nextStepIn(unchanged)).toBeUndefined()

    rmSync(path.join(dir, '.gitleaks.toml'), { force: true })
    const restored: string[] = []
    await init(dir, text => restored.push(text))
    expect(nextStepIn(restored)).toContain('pnpm run quality')
    expect(nextStepIn(restored)).not.toContain('install')
  })
})
