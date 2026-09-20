import type { TemplateVars } from '../src/presets/index.js'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { runDoctor } from '../src/commands/doctor/index.js'
import { FileReadings } from '../src/commands/doctor/readings.js'
import { buildManifest, writeManifest } from '../src/manifest.js'

const MANIFEST_VARS: TemplateVars = {
  projectName: 'readings-fixture',
  scope: '@readings-fixture',
  nodeMajor: '22',
  contracts: 'false',
  contractPath: '',
  contractTypesOutput: '',
  compositionDir: 'architecture/composition',
  harnessCommand: 'pnpm run quality',
  packageManager: 'pnpm',
  pnpmVersion: '12.4.2',
  reviewModel: '',
  constructVersion: '0.0.0-fixture',
}

function scratch(): string {
  return mkdtempSync(path.join(tmpdir(), 'construct-readings-'))
}

function pathsOf(readings: FileReadings): string[] {
  return readings.files.map(entry => entry.slice(0, entry.indexOf(' (')))
}

describe('the files doctor could not read', () => {
  it('returns the text of a file it can read and says nothing about it', () => {
    const root = scratch()
    writeFileSync(path.join(root, 'package.json'), '{}')
    const readings = new FileReadings(root)
    expect(readings.read('package.json')).toBe('{}')
    expect(readings.files).toEqual([])
  })

  it('leaves a path that is not there to the reader that reports missing files', () => {
    const readings = new FileReadings(scratch())
    expect(readings.read('package.json')).toBeNull()
    expect(readings.unreadable('package.json')).toBe(false)
    expect(readings.files).toEqual([])
  })

  it('reports one category whatever the cause, naming the cause beside the path', () => {
    const root = scratch()
    mkdirSync(path.join(root, 'tests/harness.test.ts'), { recursive: true })
    writeFileSync(path.join(root, 'package.json'), '{ not json')
    const readings = new FileReadings(root)
    expect(readings.read('tests/harness.test.ts')).toBeNull()
    expect(readings.readJson('package.json')).toBeNull()
    expect(pathsOf(readings)).toEqual(['package.json', 'tests/harness.test.ts'])
    for (const entry of readings.files)
      expect(entry).toMatch(/ \(.+\)$/)
  })

  it('reports a recorded manifest it cannot parse as one it could not read', () => {
    const root = scratch()
    writeFileSync(path.join(root, 'package.json'), '{ not json')
    const readings = new FileReadings(root)
    expect(readings.readJson('package.json')).toBeNull()
    expect(readings.unreadable('package.json')).toBe(true)
  })

  it('reports a directory it cannot list, and lists one it can', () => {
    const root = scratch()
    mkdirSync(path.join(root, 'architecture/composition'), { recursive: true })
    writeFileSync(path.join(root, 'architecture/composition/init.yaml'), 'flow: init')
    writeFileSync(path.join(root, 'architecture/models'), 'a file where a directory is expected')
    const readings = new FileReadings(root)
    expect(readings.entries('architecture/composition')).toEqual(['init.yaml'])
    expect(readings.entries('architecture/models')).toBeNull()
    expect(pathsOf(readings)).toEqual(['architecture/models'])
  })
})

function materialized(): string {
  const root = scratch()
  const content = '{ "scripts": { "quality": "pnpm lint && pnpm typecheck && pnpm test" } }'
  writeFileSync(path.join(root, 'package.json'), content)
  writeManifest(root, buildManifest({
    version: '0.0.0-fixture',
    preset: 'node-backend',
    ai: 'claude',
    review: 'none',
    vars: MANIFEST_VARS,
    written: [{ target: 'package.json', strategy: 'create', action: 'create', content }],
    contracts: false,
    previous: null,
  }))
  return root
}

describe('ok collapses toward inspection, so the two kinds of unknown part company', () => {
  it('stays true where there was nothing to inspect: no model means no verdicts and no gap in the run', () => {
    const root = materialized()
    const verdict = runDoctor(root)
    expect(verdict?.checks).toEqual([])
    expect(verdict?.unreadableFiles).toEqual([])
    expect(verdict?.ok).toBe(true)
  })

  it('goes false where inspection was obstructed, because a file it could not open is one it cannot answer for', () => {
    const root = materialized()
    rmSync(path.join(root, 'package.json'))
    mkdirSync(path.join(root, 'package.json'), { recursive: true })
    const verdict = runDoctor(root)
    expect(verdict?.unreadableFiles.map(entry => entry.split(' (')[0])).toContain('package.json')
    expect(verdict?.unreadableFiles.join('')).toContain('EISDIR')
    expect(verdict?.missingFiles).not.toContain('package.json')
    expect(verdict?.ok).toBe(false)
  })
})
