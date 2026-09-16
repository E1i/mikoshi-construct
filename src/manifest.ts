import type { FileOp } from './materialize/plan.js'
import type { AiTarget, PresetId, ReviewProvider, TemplateVars } from './presets/index.js'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export const MANIFEST_FILE = 'construct.json'

export const DISCOVERY_MARKERS = [
  'product',
  'module-map',
  'commands',
  'composition-roots',
  'dependency-policy',
  'high-effort-areas',
  'composition',
  'security-invariants',
  'defects-vs-variance',
  'open-questions',
] as const

export type DiscoveryMarker = (typeof DISCOVERY_MARKERS)[number]

export interface Manifest {
  construct: string
  createdAt: string
  preset: PresetId
  ai: AiTarget
  review: { provider: ReviewProvider, model: string } | null
  harness: { command: string }
  report: { usage: boolean }
  contracts: { path: string, types: string } | null
  vars: Record<string, string>
  files: Record<string, string>
  discovery: Record<DiscoveryMarker, string>
}

export function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

export function markerFile(marker: DiscoveryMarker, compositionDir = 'architecture/composition'): string {
  switch (marker) {
    case 'composition':
      return compositionDir
    case 'security-invariants':
      return 'architecture/security-invariants.md'
    default:
      return 'AGENTS.md'
  }
}

export function buildManifest(input: {
  version: string
  preset: PresetId
  ai: AiTarget
  review: ReviewProvider
  vars: TemplateVars
  written: FileOp[]
  contracts: boolean
}): Manifest {
  const files: Record<string, string> = {}
  for (const op of input.written)
    files[op.target] = sha256(op.content)
  const discovery = Object.fromEntries(DISCOVERY_MARKERS.map(marker => [marker, markerFile(marker, input.vars.compositionDir)])) as Record<DiscoveryMarker, string>
  return {
    construct: input.version,
    createdAt: new Date().toISOString(),
    preset: input.preset,
    ai: input.ai,
    review: input.review === 'none' ? null : { provider: input.review, model: input.vars.reviewModel },
    harness: { command: input.vars.harnessCommand },
    report: { usage: true },
    contracts: input.contracts ? { path: input.vars.contractPath, types: input.vars.contractTypesOutput } : null,
    vars: input.vars,
    files,
    discovery,
  }
}

export function writeManifest(root: string, manifest: Manifest): void {
  writeFileSync(path.join(root, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`)
}

export function readManifest(root: string): Manifest | null {
  const file = path.join(root, MANIFEST_FILE)
  if (!existsSync(file))
    return null
  return JSON.parse(readFileSync(file, 'utf8')) as Manifest
}
