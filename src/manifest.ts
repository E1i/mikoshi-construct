import type { FileOp } from './materialize/plan.js'
import type { TemplateVariant } from './materialize/templates.js'
import type { AiTarget, PresetId, ReviewProvider, TemplateVars } from './presets/index.js'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { DEFAULT_COMPOSITION_DIR } from './detect/existing.js'

export const MANIFEST_FILE = 'construct.json'
export const MANIFEST_VERSION = 4

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

export type MarkerAuthor = 'construct' | 'unknown'

export interface MarkerProvenance {
  file: string
  authoredBy: MarkerAuthor
  sha: string | null
}

export interface DiscoveryRecord {
  baseSha: string | null
  filledAt: string | null
  markers: Record<DiscoveryMarker, MarkerProvenance>
}

export interface SyncRecord {
  ranAt: string
  fromVersion: string
  toVersion: string
  files: Record<string, string>
  variants: Record<string, TemplateVariant>
}

export interface Manifest {
  manifestVersion: number
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
  variants: Record<string, TemplateVariant>
  discovery: DiscoveryRecord
  sync: SyncRecord | null
}

export function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

export function markerFile(marker: DiscoveryMarker, compositionDir: string): string {
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
  previous: Manifest | null
}): Manifest {
  const written: Record<string, string> = {}
  for (const op of input.written)
    written[op.target] = sha256(op.content)
  const files = { ...input.previous?.files, ...written }
  const markers = Object.fromEntries(DISCOVERY_MARKERS.map(marker => [marker, {
    file: markerFile(marker, input.vars.compositionDir),
    authoredBy: 'unknown',
    sha: null,
  } satisfies MarkerProvenance])) as Record<DiscoveryMarker, MarkerProvenance>
  return {
    manifestVersion: MANIFEST_VERSION,
    construct: input.previous?.construct ?? input.version,
    createdAt: input.previous?.createdAt ?? new Date().toISOString(),
    preset: input.preset,
    ai: input.ai,
    review: input.review === 'none' ? null : { provider: input.review, model: input.vars.reviewModel },
    harness: { command: input.vars.harnessCommand },
    report: { usage: true },
    contracts: input.contracts ? { path: input.vars.contractPath, types: input.vars.contractTypesOutput } : null,
    vars: input.vars,
    files,
    variants: { ...input.previous?.variants, ...variantsOf(input.written) },
    discovery: input.previous?.discovery ?? { baseSha: null, filledAt: null, markers },
    sync: input.previous?.sync ?? null,
  }
}

function variantsOf(written: FileOp[]): Record<string, TemplateVariant> {
  return Object.fromEntries(written.flatMap(op => (op.variant == null ? [] : [[op.target, op.variant] as const])))
}

function isTemplateVariant(value: unknown): value is TemplateVariant {
  return value === 'default' || value === 'existing'
}

function upgradeVariants(raw: unknown): Record<string, TemplateVariant> {
  const value = (raw ?? {}) as Record<string, unknown>
  return Object.fromEntries(Object.entries(value).flatMap(([target, variant]) => (isTemplateVariant(variant) ? [[target, variant] as const] : [])))
}

function upgradeMarker(recorded: unknown, file: string): MarkerProvenance {
  if (typeof recorded === 'string')
    return { file: recorded, authoredBy: 'unknown', sha: null }
  const value = (recorded ?? {}) as Partial<MarkerProvenance>
  return {
    file: typeof value.file === 'string' ? value.file : file,
    authoredBy: value.authoredBy === 'construct' ? 'construct' : 'unknown',
    sha: typeof value.sha === 'string' ? value.sha : null,
  }
}

function upgradeSync(raw: unknown): SyncRecord | null {
  const value = (raw ?? {}) as Partial<SyncRecord>
  if (typeof value.ranAt !== 'string' || typeof value.fromVersion !== 'string' || typeof value.toVersion !== 'string')
    return null
  return {
    ranAt: value.ranAt,
    fromVersion: value.fromVersion,
    toVersion: value.toVersion,
    files: typeof value.files === 'object' && value.files != null ? { ...value.files } : {},
    variants: upgradeVariants(value.variants),
  }
}

export class ManifestAheadOfReader extends Error {
  readonly found: number
  readonly understood: number

  constructor(found: number) {
    super(`${MANIFEST_FILE} declares manifestVersion ${found}; this binary understands ${MANIFEST_VERSION}`)
    this.name = 'ManifestAheadOfReader'
    this.found = found
    this.understood = MANIFEST_VERSION
  }
}

function declaredVersion(raw: unknown): number {
  const value = (raw as { manifestVersion?: unknown }).manifestVersion
  return typeof value === 'number' && Number.isInteger(value) ? value : 0
}

export function upgradeManifest(raw: unknown): Manifest {
  const declared = declaredVersion(raw)
  if (declared > MANIFEST_VERSION)
    throw new ManifestAheadOfReader(declared)
  const manifest = raw as Manifest
  const discovery = (manifest.discovery ?? {}) as Partial<DiscoveryRecord> & Record<string, unknown>
  const recorded = (discovery.markers ?? discovery) as Record<string, unknown>
  const markers = Object.fromEntries(DISCOVERY_MARKERS.map(marker => [
    marker,
    upgradeMarker(recorded[marker], markerFile(marker, manifest.vars?.compositionDir ?? DEFAULT_COMPOSITION_DIR)),
  ])) as Record<DiscoveryMarker, MarkerProvenance>
  return {
    ...manifest,
    manifestVersion: MANIFEST_VERSION,
    variants: upgradeVariants(manifest.variants),
    discovery: {
      baseSha: typeof discovery.baseSha === 'string' ? discovery.baseSha : null,
      filledAt: typeof discovery.filledAt === 'string' ? discovery.filledAt : null,
      markers,
    },
    sync: upgradeSync(manifest.sync),
  }
}

export function recordSync(manifest: Manifest, run: { ranAt: string, toVersion: string, files: Record<string, string>, variants?: Record<string, TemplateVariant> }): Manifest {
  return {
    ...manifest,
    sync: {
      ranAt: run.ranAt,
      fromVersion: manifest.construct,
      toVersion: run.toVersion,
      files: { ...manifest.sync?.files, ...run.files },
      variants: { ...manifest.sync?.variants, ...run.variants },
    },
  }
}

export function recordedShas(manifest: Manifest): Record<string, string> {
  return { ...manifest.files, ...manifest.sync?.files }
}

export function recordedVariants(manifest: Manifest): Record<string, TemplateVariant> {
  return { ...manifest.variants, ...manifest.sync?.variants }
}

export function writeManifest(root: string, manifest: Manifest): void {
  writeFileSync(path.join(root, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`)
}

export function readManifest(root: string): Manifest | null {
  const file = path.join(root, MANIFEST_FILE)
  if (!existsSync(file))
    return null
  return upgradeManifest(JSON.parse(readFileSync(file, 'utf8')))
}
