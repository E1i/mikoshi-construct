import type { Manifest } from '../src/manifest.js'
import type { PathClassification } from '../src/sync/classify.js'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { factsTheRepositoryEstablishes } from '../src/detect/facts.js'
import { upgradeManifest } from '../src/manifest.js'
import { replay } from '../src/sync/replay.js'
import { VERSION } from '../src/version.js'

const FROZEN = path.resolve(import.meta.dirname, 'fixtures/manifests')

function folders(): string[] {
  return readdirSync(FROZEN, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
}

function frozen(folder: string): Manifest {
  return upgradeManifest(JSON.parse(readFileSync(path.join(FROZEN, folder, 'construct.json'), 'utf8')))
}

function scratch(): string {
  return mkdtempSync(path.join(tmpdir(), 'construct-facts-'))
}

function classificationsIn(root: string, manifest: Manifest): PathClassification[] {
  return replay({ root, manifest, version: VERSION, facts: factsTheRepositoryEstablishes(root) }).classifications
}

function agentsMd(root: string, manifest: Manifest): string {
  return replay({ root, manifest, version: VERSION, facts: factsTheRepositoryEstablishes(root) }).produced['AGENTS.md']
}

function withCompositionModelsAt(root: string, dir: string): string {
  mkdirSync(path.join(root, dir), { recursive: true })
  writeFileSync(path.join(root, dir, 'flow.yaml'), 'flow: scratch\n')
  return root
}

const CARRYING_NO_COMPOSITION_DIR = folders().filter(folder => frozen(folder).vars.compositionDir == null)

describe('a variable the detector establishes about the repository is not demanded from the owner', () => {
  it('freezes manifests that carry no compositionDir, which is what this establishes', () => {
    expect(CARRYING_NO_COMPOSITION_DIR).toEqual(['monorepo-0.1.0-names-replaced', 'monorepo-0.1.0-second-names-replaced', 'node-backend-0.1.0-names-replaced'])
  })

  for (const folder of CARRYING_NO_COMPOSITION_DIR) {
    it(`${folder} replays without being edited once the repository shows where its models live`, () => {
      const root = withCompositionModelsAt(scratch(), 'architecture/composition')
      expect(classificationsIn(root, frozen(folder)).length).toBeGreaterThan(0)
    })

    it(`${folder} renders the composition directory the repository carries`, () => {
      const root = withCompositionModelsAt(scratch(), 'docs/composition')
      expect(agentsMd(root, frozen(folder))).toContain('docs/composition')
    })

    it(`${folder} stops and names the variable when the repository shows nothing, rather than choosing for the owner`, () => {
      expect(() => classificationsIn(scratch(), frozen(folder))).toThrow(/compositionDir/)
    })
  }

  it('never re-detects a value the manifest already carries', () => {
    const folder = 'node-frontend-0.1.1-names-replaced'
    const manifest = frozen(folder)
    expect(manifest.vars.compositionDir).toBe('architecture/composition')

    const bare = scratch()
    const wouldDetectSomethingElse = withCompositionModelsAt(scratch(), 'docs/composition')
    expect(agentsMd(wouldDetectSomethingElse, manifest)).not.toContain('docs/composition')
    expect(classificationsIn(wouldDetectSomethingElse, manifest)).toEqual(classificationsIn(bare, manifest))
  })

  it('stops for a variable that describes the machine and not the repository', () => {
    const manifest = frozen('node-backend-0.1.0-names-replaced')
    const { nodeMajor, pnpmVersion, ...carried } = manifest.vars
    expect(nodeMajor).toBeDefined()
    expect(pnpmVersion).toBeDefined()

    let message = ''
    try {
      classificationsIn(withCompositionModelsAt(scratch(), 'architecture/composition'), { ...manifest, vars: carried })
    }
    catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain('nodeMajor')
    expect(message).toContain('pnpmVersion')
    expect(message).not.toContain('compositionDir')
    expect(message).toContain('"vars"')
  })
})

describe('a fact is what the repository shows, never what init would have chosen', () => {
  it('establishes nothing when the repository has no composition directory, so the replay stops and names it', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'construct-facts-'))
    expect(factsTheRepositoryEstablishes(root)).toEqual({})
  })

  it('borrows no default from init: the value init would supply is never produced as a fact', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'construct-facts-'))
    expect(Object.values(factsTheRepositoryEstablishes(root))).not.toContain('architecture/composition')
  })
})
