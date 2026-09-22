import type { DiscoveryMarker, Manifest } from '../src/manifest.js'
import type { TemplateVars } from '../src/presets/index.js'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { markerClose, markerOpen } from '../src/commands/doctor/discovery.js'
import { printDoctor, runDoctor } from '../src/commands/doctor/index.js'
import { discoveryProvenance, MARKER_AUTHORSHIP, markerAuthorship } from '../src/commands/doctor/provenance.js'
import { buildManifest, DISCOVERY_MARKERS, readManifest, sha256, upgradeManifest, writeManifest } from '../src/manifest.js'
import { createUi } from '../src/ui/console.js'
import { PLAIN_LORE } from '../src/ui/lore.js'
import { resolveTheme } from '../src/ui/theme.js'

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

function repositoryWithOneMarkerRecorded(marker: DiscoveryMarker, wrote: string, bodyNow: string): string {
  const root = mkdtempSync(path.join(tmpdir(), 'construct-provenance-'))
  writeFileSync(path.join(root, 'AGENTS.md'), agentsWith({ [marker]: bodyNow }))
  const manifest = buildManifest({ version: VARS.constructVersion, preset: 'node-backend', ai: 'claude', review: 'none', vars: VARS, written: [], contracts: false, previous: null, policy: null })
  manifest.discovery.markers[marker] = { file: 'AGENTS.md', authoredBy: 'construct', sha: sha256(wrote) }
  manifest.discovery.baseSha = 'c0ffee'
  manifest.discovery.filledAt = '2026-09-17T00:00:00.000Z'
  writeManifest(root, manifest)
  return root
}

function provenanceSection(root: string): string {
  const written: string[] = []
  const ui = createUi(resolveTheme({ plain: true }), text => written.push(text))
  printDoctor(ui, runDoctor(root))
  // eslint-disable-next-line no-control-regex
  const lines = written.join('').replaceAll(/\u001B\[[\d;]*m/g, '').split('\n')
  const start = lines.findIndex(line => line.includes(PLAIN_LORE.provenance))
  if (start < 0)
    return ''
  const rest = lines.slice(start + 1)
  const end = rest.findIndex(line => line.trim() === '')
  return (end < 0 ? rest : rest.slice(0, end)).join('\n')
}

describe('a repository recording one marker and nothing for the other nine', () => {
  it('names the nine that carry no recorded provenance, rather than printing nothing about them', () => {
    const section = provenanceSection(repositoryWithOneMarkerRecorded('open-questions', 'What discovery wrote.', 'What discovery wrote.'))
    expect(section).toMatch(/\b9 markers\b/)
  })

  it('reports a marker whose body no longer matches its recorded sha, and does not count it among those never recorded', () => {
    const section = provenanceSection(repositoryWithOneMarkerRecorded('open-questions', 'What discovery wrote.', 'The owner\'s own paragraph.'))
    expect(section).toContain('open-questions')
    expect(section).not.toMatch(/\b10 markers\b/)
    expect(section).toMatch(/\b9 markers\b/)
  })
})

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
    expect(result?.provenance.filter(reading => reading.authorship === 'unrecorded').map(reading => reading.marker)).toContain('module-map')
  })

  it('separates never recorded from recorded but unreadable, rather than answering both with one word', () => {
    expect(markerAuthorship({ file: 'AGENTS.md', authoredBy: 'unknown', sha: null }, 'a body')).toBe('unrecorded')
    expect(markerAuthorship({ file: 'AGENTS.md', authoredBy: 'construct', sha: sha256('a body') }, null)).toBe('unreadable')
    expect(markerAuthorship({ file: 'AGENTS.md', authoredBy: 'construct', sha: sha256('a body') }, 'a body')).toBe('construct')
    expect(markerAuthorship({ file: 'AGENTS.md', authoredBy: 'construct', sha: sha256('a body') }, 'another body')).toBe('owner')
  })

  it('reads a record claiming construct authorship with no sha as nothing recorded, the only place that combination can arrive', () => {
    const upgraded = upgradeManifest({
      manifestVersion: 2,
      vars: { compositionDir: 'architecture/composition' },
      discovery: { markers: { product: { file: 'AGENTS.md', authoredBy: 'construct', sha: null } } },
    })
    expect(upgraded.discovery.markers.product).toEqual({ file: 'AGENTS.md', authoredBy: 'unknown', sha: null })
    expect(markerAuthorship(upgraded.discovery.markers.product, 'a body')).toBe('unrecorded')
  })
})

describe('docs/cli.md explains every reading doctor can give a marker', () => {
  const document = readFileSync(path.join(import.meta.dirname, '../docs/cli.md'), 'utf8')

  function unexplained(readings: readonly string[]): string[] {
    return readings.filter(reading => !document.includes(`| \`${reading}\` |`))
  }

  it('explains each of them, with what it means beside it', () => {
    expect(unexplained(MARKER_AUTHORSHIP)).toEqual([])
  })

  it('reads the readings from src/commands/doctor/provenance.ts, so one added there and left undocumented turns red', () => {
    expect(unexplained([...MARKER_AUTHORSHIP, 'invented-reading'])).toEqual(['invented-reading'])
  })
})
