import type { FileOp } from './materialize/plan.js'
import type { TemplateVariant } from './materialize/templates.js'
import type { AiTarget, PresetId, ReviewProvider, ServeRecord, TemplateVars, WorkspaceImports } from './presets/index.js'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { DEFAULT_COMPOSITION_DIR } from './detect/existing.js'
import { SUCCESSORS } from './presets/index.js'
import { RecordAheadOfReader } from './record-ahead.js'

export const MANIFEST_FILE = 'construct.json'
export const MANIFEST_VERSION = 6
export const DEFAULT_LANES = 3

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

export type MarkerProvenance
  = | { file: string, authoredBy: 'construct', sha: string }
    | { file: string, authoredBy: 'unknown', sha: null }

export interface DiscoveryRecord {
  baseSha: string | null
  filledAt: string | null
  markers: Record<DiscoveryMarker, MarkerProvenance>
}

export interface BlockRecord {
  ownedSha: string
  vars: Record<string, string>
}

export interface SyncRecord {
  ranAt: string
  fromVersion: string
  toVersion: string
  files: Record<string, string>
  variants: Record<string, TemplateVariant>
  blocks: Record<string, BlockRecord>
}

export interface PolicyRecord {
  workspaceImports: WorkspaceImports
}

export interface AtlasRecord {
  open: string
}

export interface ShiftRecord {
  prepush: string[]
  handoffWrite?: string
  codeMatrix?: string
}

export interface ShiftGate {
  prepush: string[]
  handoffWrite: string | null
  codeMatrix: string | null
}

export const DEFAULT_CLIENT_MODEL = 'auto'

export const CLIENT_IDS = ['claude', 'codex'] as const

export const CLIENT_ROLES = ['launch', 'answer', 'review', 'window'] as const
export type ClientRole = (typeof CLIENT_ROLES)[number]

export interface ClientRecord {
  id?: string
  model?: string
  roles?: Partial<Record<ClientRole, string>>
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
  blocks: Record<string, BlockRecord>
  discovery: DiscoveryRecord
  sync: SyncRecord | null
  policy: PolicyRecord | null
  milestones?: string[]
  atlas?: AtlasRecord
  lanes?: number
  shift?: ShiftRecord
  serve?: ServeRecord
  client?: ClientRecord
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
    case 'open-questions':
      return 'architecture/open-questions.md'
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
  ownedShas: Record<string, string>
  contracts: boolean
  previous: Manifest | null
  policy: WorkspaceImports | null
  lanes?: number
  serve?: ServeRecord
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
    blocks: { ...input.previous?.blocks, ...blocksWrittenWith(input.ownedShas, input.vars) },
    discovery: input.previous?.discovery ?? { baseSha: null, filledAt: null, markers },
    sync: input.previous?.sync ?? null,
    policy: input.policy == null ? input.previous?.policy ?? null : { workspaceImports: input.policy },
    lanes: input.lanes ?? input.previous?.lanes,
    serve: input.previous?.serve ?? input.serve,
    client: input.previous?.client,
  }
}

function variantsOf(written: FileOp[]): Record<string, TemplateVariant> {
  return Object.fromEntries(written.flatMap(op => (op.variant == null ? [] : [[op.target, op.variant] as const])))
}

export function blocksWrittenWith(ownedShas: Record<string, string>, vars: Record<string, string>): Record<string, BlockRecord> {
  return Object.fromEntries(Object.entries(ownedShas).map(([target, ownedSha]) => [target, { ownedSha, vars: { ...vars } }]))
}

function isBlockRecord(value: unknown): value is BlockRecord {
  const candidate = value as Partial<BlockRecord> | null
  return typeof candidate?.ownedSha === 'string' && typeof candidate.vars === 'object' && candidate.vars != null
}

function upgradeBlocks(raw: unknown): Record<string, BlockRecord> {
  const value = (raw ?? {}) as Record<string, unknown>
  return Object.fromEntries(Object.entries(value).flatMap(([target, block]) => (isBlockRecord(block) ? [[target, { ownedSha: block.ownedSha, vars: { ...block.vars } }] as const] : [])))
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
  const value = (recorded ?? {}) as Partial<{ file: unknown, authoredBy: unknown, sha: unknown }>
  const recordedFile = typeof value.file === 'string' ? value.file : file
  if (value.authoredBy !== 'construct' || typeof value.sha !== 'string')
    return { file: recordedFile, authoredBy: 'unknown', sha: null }
  return { file: recordedFile, authoredBy: 'construct', sha: value.sha }
}

function upgradePolicy(raw: unknown): PolicyRecord | null {
  const value = (raw ?? {}) as Partial<PolicyRecord>
  if (typeof value.workspaceImports !== 'object' || value.workspaceImports == null)
    return null
  const entries = Object.entries(value.workspaceImports).flatMap(([dir, allowed]) =>
    (Array.isArray(allowed) && allowed.every(name => typeof name === 'string') ? [[dir, [...allowed] as string[]]] : []))
  return { workspaceImports: Object.fromEntries(entries) }
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
    blocks: upgradeBlocks(value.blocks),
  }
}

function upgradeAtlas(raw: unknown): AtlasRecord | undefined {
  const value = (raw ?? {}) as Partial<AtlasRecord>
  return typeof value.open === 'string' && value.open !== '' ? { open: value.open } : undefined
}

function declaredText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function upgradeShift(raw: unknown): ShiftRecord | undefined {
  const value = (raw ?? {}) as Partial<Record<keyof ShiftRecord, unknown>>
  const prepush = Array.isArray(value.prepush) ? value.prepush.map(declaredText).filter(command => command !== undefined) : []
  if (prepush.length === 0)
    return undefined
  const handoffWrite = declaredText(value.handoffWrite)
  const codeMatrix = declaredText(value.codeMatrix)
  return { prepush, ...(handoffWrite === undefined ? {} : { handoffWrite }), ...(codeMatrix === undefined ? {} : { codeMatrix }) }
}

function upgradeServe(raw: unknown): ServeRecord | undefined {
  const value = (raw ?? {}) as Partial<Record<keyof ServeRecord, unknown>>
  const command = declaredText(value.command)
  const url = declaredText(value.url)
  if (command === undefined || url === undefined || !URL.canParse(url) || !isPositiveInteger(value.readyTimeoutMs))
    return undefined
  return { command, url, readyTimeoutMs: value.readyTimeoutMs }
}

function upgradeClientRoles(raw: unknown): Partial<Record<ClientRole, string>> | undefined {
  const value = (raw ?? {}) as Partial<Record<ClientRole, unknown>>
  const entries = CLIENT_ROLES.flatMap((role) => {
    const id = declaredText(value[role])
    return id === undefined ? [] : [[role, id] as const]
  })
  return entries.length === 0 ? undefined : Object.fromEntries(entries)
}

function upgradeClient(raw: unknown): ClientRecord | undefined {
  if (typeof raw !== 'object' || raw == null)
    return undefined
  const value = raw as Partial<Record<keyof ClientRecord, unknown>>
  const id = declaredText(value.id)
  const model = declaredText(value.model)
  const roles = upgradeClientRoles(value.roles)
  if (id === undefined && model === undefined && roles === undefined)
    return undefined
  return {
    ...(id === undefined ? {} : { id }),
    ...(model === undefined ? {} : { model }),
    ...(roles === undefined ? {} : { roles }),
  }
}

export function clientIdsNamed(record: ClientRecord | undefined): string[] {
  const named = [record?.id, ...CLIENT_ROLES.map(role => record?.roles?.[role])]
  return [...new Set(named.filter((id): id is string => id !== undefined))]
}

export function clientIdsWithNoAdapter(record: ClientRecord | undefined): string[] {
  const known = new Set<string>(CLIENT_IDS)
  return clientIdsNamed(record).filter(id => !known.has(id))
}

export function clientIdFor(record: ClientRecord | undefined, role: ClientRole): string | null {
  return record?.roles?.[role] ?? record?.id ?? null
}

export function clientModelOf(record: ClientRecord | undefined): string {
  return record?.model ?? DEFAULT_CLIENT_MODEL
}

export function shiftGateOf(manifest: Manifest | null): ShiftGate {
  const shift = manifest?.shift
  const fallback = manifest?.harness.command
  return {
    prepush: shift?.prepush ?? (fallback === undefined ? [] : [fallback]),
    handoffWrite: shift?.handoffWrite ?? null,
    codeMatrix: shift?.codeMatrix ?? null,
  }
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

export function isLaneCount(value: unknown): value is number {
  return isPositiveInteger(value)
}

function declaredVersion(raw: unknown): number {
  const value = (raw as { manifestVersion?: unknown }).manifestVersion
  return typeof value === 'number' && Number.isInteger(value) ? value : 0
}

export function upgradeManifest(raw: unknown): Manifest {
  const declared = declaredVersion(raw)
  if (declared > MANIFEST_VERSION)
    throw new RecordAheadOfReader(MANIFEST_FILE, 'manifestVersion', declared, MANIFEST_VERSION)
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
    blocks: upgradeBlocks(manifest.blocks),
    discovery: {
      baseSha: typeof discovery.baseSha === 'string' ? discovery.baseSha : null,
      filledAt: typeof discovery.filledAt === 'string' ? discovery.filledAt : null,
      markers,
    },
    sync: upgradeSync(manifest.sync),
    policy: upgradePolicy(manifest.policy),
    atlas: upgradeAtlas(manifest.atlas),
    lanes: isLaneCount(manifest.lanes) ? manifest.lanes : undefined,
    shift: upgradeShift(manifest.shift),
    serve: upgradeServe(manifest.serve),
    client: upgradeClient(manifest.client),
  }
}

export function readAtlasRecord(root: string): AtlasRecord | undefined {
  return readManifest(root)?.atlas
}

export function recordSync(manifest: Manifest, run: { ranAt: string, toVersion: string, files: Record<string, string>, variants?: Record<string, TemplateVariant>, blocks?: Record<string, BlockRecord> }): Manifest {
  return {
    ...manifest,
    sync: {
      ranAt: run.ranAt,
      fromVersion: manifest.construct,
      toVersion: run.toVersion,
      files: { ...manifest.sync?.files, ...run.files },
      variants: { ...manifest.sync?.variants, ...run.variants },
      blocks: { ...manifest.sync?.blocks, ...run.blocks },
    },
  }
}

export function recordedShas(manifest: Manifest): Record<string, string> {
  const recorded: Record<string, string> = { ...manifest.files, ...manifest.sync?.files }
  return Object.fromEntries(Object.entries(recorded).filter(([target]) => {
    const successor = SUCCESSORS[target]
    return successor == null || recorded[successor] == null
  }))
}

export function recordedVariants(manifest: Manifest): Record<string, TemplateVariant> {
  return { ...manifest.variants, ...manifest.sync?.variants }
}

export function recordedBlocks(manifest: Manifest): Record<string, BlockRecord> {
  return { ...manifest.blocks, ...manifest.sync?.blocks }
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

export function readMilestones(root: string): string[] | undefined {
  return readManifest(root)?.milestones
}

export function readShiftGate(root: string): ShiftGate {
  return shiftGateOf(readManifest(root))
}
