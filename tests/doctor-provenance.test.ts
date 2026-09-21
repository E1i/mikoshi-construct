import type { Manifest } from '../src/manifest.js'
import type { TemplateVars } from '../src/presets/index.js'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { markerClose, markerOpen } from '../src/commands/doctor/discovery.js'
import { runDoctor } from '../src/commands/doctor/index.js'
import { discoveryProvenance, markerAuthorship } from '../src/commands/doctor/provenance.js'
import { buildManifest, DISCOVERY_MARKERS, readManifest, sha256, writeManifest } from '../src/manifest.js'

const VARS: TemplateVars = {
  projectName: 'fixture',
  scope: '@fixture',
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

function agentsWith(bodies: Record<string, string>): string {
  return Object.entries(bodies).map(([marker, body]) => `${markerOpen(marker)}\n\n${body}\n\n${markerClose(marker)}\n`).join('\n')
}

function repositoryAfterDiscovery(bodies: Record<string, string>, written: Record<string, string> = bodies): string {
  const root = mkdtempSync(path.join(tmpdir(), 'construct-provenance-'))
  writeFileSync(path.join(root, 'AGENTS.md'), agentsWith(bodies))
  mkdirSync(path.join(root, 'architecture/composition'), { recursive: true })
  writeFileSync(path.join(root, 'architecture/composition/app.yaml'), 'id: app\n')
  const manifest = buildManifest({ version: VARS.constructVersion, preset: 'node-backend', ai: 'claude', review: 'none', vars: VARS, written: [], contracts: false, previous: null, policy: null })
  for (const [marker, body] of Object.entries(written))
    manifest.discovery.markers[marker as 'product'] = { file: 'AGENTS.md', authoredBy: 'construct', sha: sha256(body) }
  manifest.discovery.markers.composition = { file: 'architecture/composition', authoredBy: 'construct', sha: sha256('app.yaml\nid: app\n') }
  manifest.discovery.baseSha = 'c0ffee'
  manifest.discovery.filledAt = '2026-09-17T00:00:00.000Z'
  writeManifest(root, manifest)
  return root
}

describe('who a discovery marker belongs to is derived, never declared twice', () => {
  it('reports one reading per marker, each naming the file the manifest records for it', () => {
    const root = repositoryAfterDiscovery({ product: 'What discovery wrote.' })
    const readings = discoveryProvenance(root, readManifest(root) as Manifest)
    expect(readings.map(reading => reading.marker)).toEqual([...DISCOVERY_MARKERS])
    expect(readings.find(reading => reading.marker === 'security-invariants')?.file).toBe('architecture/security-invariants.md')
  })

  it('reads a rewritten marker as the owner\'s, with no command to run and nothing written back', () => {
    const root = repositoryAfterDiscovery({ product: 'The owner\'s own paragraph.' }, { product: 'What discovery wrote.' })
    const readings = runDoctor(root)?.provenance ?? []
    expect(readings.find(reading => reading.marker === 'product')?.authorship).toBe('owner')
  })

  it('reads an unedited marker as the construct still talking to itself, and doctor names it without changing the exit code', () => {
    const root = repositoryAfterDiscovery({ product: 'What discovery wrote.' })
    const result = runDoctor(root)
    expect(result?.provenance.find(reading => reading.marker === 'product')?.authorship).toBe('construct')
    expect(result?.provenance.find(reading => reading.marker === 'composition')?.authorship).toBe('construct')
    expect(result?.provenance.filter(reading => reading.authorship === 'unknown').map(reading => reading.marker)).toContain('module-map')
  })

  it('leaves intent unknown where no provenance was ever recorded, rather than assuming either side wrote it', () => {
    expect(markerAuthorship({ file: 'AGENTS.md', authoredBy: 'unknown', sha: null }, 'a body')).toBe('unknown')
    expect(markerAuthorship({ file: 'AGENTS.md', authoredBy: 'construct', sha: null }, 'a body')).toBe('unknown')
    expect(markerAuthorship({ file: 'AGENTS.md', authoredBy: 'construct', sha: sha256('a body') }, null)).toBe('unknown')
    expect(markerAuthorship({ file: 'AGENTS.md', authoredBy: 'construct', sha: sha256('a body') }, 'a body')).toBe('construct')
    expect(markerAuthorship({ file: 'AGENTS.md', authoredBy: 'construct', sha: sha256('a body') }, 'another body')).toBe('owner')
  })
})
