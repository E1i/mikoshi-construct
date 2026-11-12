import { FACTORY_FOLDERS, FACTORY_NAMED, GENERATED_FILES, RATCHET_FILE } from '../core/factory-paths.js'

export const PREFIX_SUFFIX = '/**'
export const CHANGESET_COMPANION = `.changeset${PREFIX_SUFFIX}`
export const OWNER_MERGES = 'architecture/owner-merges.md'
export const COMPOSITION_ROOT = 'architecture/composition'
export const LAYER_ENTRY_PREFIX = 'layer:'
export const TEST_ROOTS = ['tests', FACTORY_FOLDERS.tests[0]]
export const CREATES_KINDS = ['ghosts', 'plain'] as const

export type CreatesKind = typeof CREATES_KINDS[number]

export type ParsedCreatesEntry = { kind: 'created', path: string, fileKind: CreatesKind | null } | { kind: 'refused', reason: string }

export const FACTORY_MANIFEST: readonly string[] = [
  '.claude/agents/brief.md',
  '.claude/agents/review.md',
  '.claude/agents/scan.md',
  '.claude/skills/probe/SKILL.md',
  '.claude/eddies.json',
  '.claude/settings.json',
  'architecture/decisions/window-allow-merge.md',
  OWNER_MERGES,
  'scripts/construct/check-acceptance.mjs',
  'scripts/construct/eddies.mjs',
  'scripts/construct/eddies-measure.mjs',
  'scripts/construct/environment-print.mjs',
  'scripts/construct/shell-parser.mjs',
  'scripts/construct/window-heartbeat.mjs',
  'scripts/construct/window-hooks.mjs',
]

const LADDER = 'the ladder mechanism a task runs on'
const APPROVAL_RULES = 'the rules by which a brief is approved'
const FOREIGN_WRITE = 'what attach, sync or detach write into another repository'
const CARRIERS = 'the registration of the carriers attach delivers'
export const SECURITY_REASON = 'a security invariant'
export const FACTORY_REASON = 'the factory mechanism that decides on closing, merging and admitting a task'
const PUBLISH = 'a publish, which cannot be unpublished'
const ALWAYS_HIGH = 'always high: the composition models, the lint policy and who merges'

const CORE: readonly (readonly [string, string])[] = [
  ['.claude/skills/implement', LADDER],
  ['.claude/agents', LADDER],
  ['scripts/construct', LADDER],
  [FACTORY_NAMED.ghostsApproval, LADDER],
  [FACTORY_NAMED.ghostsHashing, LADDER],
  [FACTORY_NAMED.ghostsLaunch, LADDER],
  [FACTORY_NAMED.ghostsApprove, APPROVAL_RULES],
  ['architecture/decisions/0053-morse-approves-a-brief-the-risk-matrix-does-not-reserve-for-the-owner.md', APPROVAL_RULES],
  ['architecture/decisions/0058-morse-approves-a-brief-of-every-risk.md', APPROVAL_RULES],
  ['templates/ai/claude/_claude/skills/implement', LADDER],
  ['templates/ai/claude/_claude/agents', LADDER],
  ['templates/ai/claude/scripts/construct', LADDER],
  ['templates', FOREIGN_WRITE],
  ['src/materialize', FOREIGN_WRITE],
  ['src/sync', FOREIGN_WRITE],
  ['src/manifest.ts', FOREIGN_WRITE],
  ['src/presets', CARRIERS],
  ['src/commands/attach', FOREIGN_WRITE],
  ['src/commands/sync', FOREIGN_WRITE],
  ['src/commands/detach', FOREIGN_WRITE],
  ['scripts/attach', CARRIERS],
  ['architecture/security-invariants.md', SECURITY_REASON],
  ['.changeset/config.json', PUBLISH],
  ['scripts/release', PUBLISH],
  ['.github/workflows', PUBLISH],
  [COMPOSITION_ROOT, ALWAYS_HIGH],
  ['eslint.config.mjs', ALWAYS_HIGH],
  [OWNER_MERGES, ALWAYS_HIGH],
  [FACTORY_NAMED.busQueue, FACTORY_REASON],
  [FACTORY_NAMED.busAdmissions, FACTORY_REASON],
  [FACTORY_NAMED.busCloseExecutor, FACTORY_REASON],
  [FACTORY_NAMED.busMergeExecutor, FACTORY_REASON],
  [FACTORY_NAMED.busRoundLimitDecision, FACTORY_REASON],
  [FACTORY_NAMED.busUpdateDone, FACTORY_REASON],
]

const CREATES_ENTRY = /^(\S+)(?: \((\S+)\))?$/
const WORD_BOUNDARY = /[\s,;:()[\]"'`?!<>]+/
const TRAILING_DOTS = /\.+$/
const FILE_EXTENSION = /\.[a-z][\w-]*$/i
const TEST_FILE = /\.test\.ts$/
const WORKSPACE_TEST_ROOT = /^(?:apps|packages)\/[^/]+\/tests\//
const TEMPLATE_GROUP_FILE = /^templates\/(?:base|harness|attach|ai\/[^/]+|stacks\/[^/]+|presets\/[^/]+\/[^/]+)\/(.+)$/
const DOT_SEGMENT = /(^|\/)_/g
const RENDERED_SUFFIX = /(?:\.existing)?\.eta$/
const CHANGESET_FILE = /^\.changeset\/(?!readme\.md$)[^/]+\.md$/i
const SECURITY_PATHS = ['architecture/security-invariants.md', '.gitleaks.toml', '.github/workflows']
const NEVER_FOLLOWING = ['.claude', OWNER_MERGES, ...SECURITY_PATHS]
const GENERATED_PATHS: readonly string[] = [RATCHET_FILE.path, ...Object.values(GENERATED_FILES).map(row => row.path)]

export interface CompositionRecord {
  id: string
  doc: string
  nodes: readonly { path?: string }[]
}

export const KNOWN_VIOLATIONS = '.dependency-cruiser-known-violations.json'
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/
const NO_NEWLINE_MARK = '\\'

export interface FollowingReach {
  touches: readonly string[]
  added: ReadonlySet<string>
  compositionRecords: readonly CompositionRecord[]
  entriesOnlyRemoved?: (file: string) => boolean
}

function jsonArrayOrNull(text: string): string[] | null {
  try {
    const parsed: unknown = JSON.parse(text)
    return Array.isArray(parsed) ? parsed.map(entry => JSON.stringify(entry)) : null
  }
  catch {
    return null
  }
}

export function removesEntriesOnly(before: string | null, after: string | null): boolean {
  const was = before === null ? null : jsonArrayOrNull(before)
  const is = after === null ? null : jsonArrayOrNull(after)
  if (was === null || is === null || is.length >= was.length)
    return false
  const left = [...was]
  return is.every((entry) => {
    const at = left.indexOf(entry)
    if (at === -1)
      return false
    left.splice(at, 1)
    return true
  })
}

export function textBeforePatch(after: string, patch: string): string | null {
  const lines = after.split('\n')
  const before: string[] = []
  let next = 0
  for (const line of patch.split('\n')) {
    const header = HUNK_HEADER.exec(line)
    if (header !== null) {
      const start = Number(header[1]) - (header[2] === '0' ? 0 : 1)
      if (start < next)
        return null
      before.push(...lines.slice(next, start))
      next = start
    }
    else if (line.startsWith('-')) {
      before.push(line.slice(1))
    }
    else if (line.startsWith('+') || line.startsWith(' ')) {
      if (lines[next] !== line.slice(1))
        return null
      if (line.startsWith(' '))
        before.push(line.slice(1))
      next += 1
    }
    else if (line !== '' && !line.startsWith(NO_NEWLINE_MARK)) {
      return null
    }
  }
  return [...before, ...lines.slice(next)].join('\n')
}

export interface FollowingRow {
  kind: string
  follows: (file: string, reach: FollowingReach) => boolean
}

export function parseCreatesEntry(entry: string): ParsedCreatesEntry {
  const found = CREATES_ENTRY.exec(entry.trim())
  if (found === null)
    return { kind: 'refused', reason: `creates entry '${entry.trim()}' is '<path>' or '<path> (<kind>)', the kind one of ${CREATES_KINDS.join(', ')}` }
  const [, path, fileKind] = found as unknown as [string, string, string | undefined]
  if (fileKind !== undefined && !(CREATES_KINDS as readonly string[]).includes(fileKind))
    return { kind: 'refused', reason: `creates entry '${entry.trim()}' names kind '${fileKind}', not one of ${CREATES_KINDS.join(', ')}` }
  return { kind: 'created', path, fileKind: (fileKind ?? null) as CreatesKind | null }
}

export function createdPaths(entries: readonly string[]): string[] {
  return entries.flatMap((entry) => {
    const parsed = parseCreatesEntry(entry)
    return parsed.kind === 'created' ? [parsed.path] : []
  })
}

export function isLayerEntry(entry: string): boolean {
  return entry.startsWith(LAYER_ENTRY_PREFIX)
}

export function layerNamedBy(entry: string): string {
  return entry.slice(LAYER_ENTRY_PREFIX.length)
}

export function entryScope(entry: string): { path: string, prefix: boolean } {
  return entry.endsWith(PREFIX_SUFFIX) ? { path: entry.slice(0, -PREFIX_SUFFIX.length), prefix: true } : { path: entry, prefix: false }
}

export function scopePath(entry: string): string {
  return entryScope(entry).path
}

export function under(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`)
}

export function entryUnder(entry: string, root: string): boolean {
  return under(scopePath(entry), root)
}

export function reaches(entry: string, root: string): boolean {
  const scope = entryScope(entry)
  return under(scope.path, root) || (scope.prefix && under(root, scope.path))
}

export function entryCovers(touch: string, companion: string): boolean {
  return touch === companion || (touch.endsWith(PREFIX_SUFFIX) && entryUnder(companion, scopePath(touch)))
}

export function coreReasonOf(touch: string): string | undefined {
  return touch === CHANGESET_COMPANION ? undefined : CORE.find(([root]) => reaches(touch, root))?.[1]
}

export function isTest(file: string): boolean {
  return TEST_FILE.test(file) && TEST_ROOTS.some(root => file.startsWith(`${root}/`))
}

export function coversByImport(file: string): boolean {
  return isTest(file) || (TEST_FILE.test(file) && WORKSPACE_TEST_ROOT.test(file))
}

export function isTestScope(entry: string): boolean {
  if (isLayerEntry(entry))
    return true
  if (!entry.endsWith(PREFIX_SUFFIX))
    return coversByImport(entry)
  const scope = `${entry.slice(0, -PREFIX_SUFFIX.length)}/`
  return TEST_ROOTS.some(root => scope.startsWith(`${root}/`)) || WORKSPACE_TEST_ROOT.test(scope)
}

export function withinTouches(file: string, touches: readonly string[]): boolean {
  return touches.some(entry => entry.endsWith(PREFIX_SUFFIX)
    ? file.startsWith(`${entry.slice(0, -PREFIX_SUFFIX.length)}/`)
    : file === entry)
}

export function narrowestMask(file: string, masks: readonly string[]): string | undefined {
  return masks.filter(mask => withinTouches(file, [mask])).sort((a, b) => b.length - a.length)[0]
}

export function runsCover(file: string, runs: readonly string[]): boolean {
  return coversByImport(file) && withinTouches(file, runs)
}

export function pathsIn(text: string): string[] {
  return [...new Set(text.split(WORD_BOUNDARY).map(word => word.replace(TRAILING_DOTS, '')).filter(word => word.includes('/') || FILE_EXTENSION.test(word)))]
}

export function pathsOutside(touches: readonly string[], creates: readonly string[], paths: readonly string[]): string[] {
  const reach = [...touches, ...createdPaths(creates)]
  return paths.filter(file => !withinTouches(file, reach))
}

function reachesAny(touches: readonly string[], roots: readonly string[]): boolean {
  return touches.some(touch => roots.some(root => entryUnder(touch, root) || (touch.endsWith(PREFIX_SUFFIX) && entryUnder(root, scopePath(touch)))))
}

export function rootCopyOf(entry: string): string | null {
  const copy = TEMPLATE_GROUP_FILE.exec(scopePath(entry))?.[1]
  if (copy === undefined)
    return null
  const rendered = copy.replace(DOT_SEGMENT, '$1.')
  return entry.endsWith(PREFIX_SUFFIX) ? `${rendered}${PREFIX_SUFFIX}` : rendered.replace(RENDERED_SUFFIX, '')
}

function generatedFrom(generated: string, sources: readonly string[]): FollowingRow['follows'] {
  return (file, reach) => file === generated && reachesAny(reach.touches, sources)
}

function reachedRecordFollows(file: string, reach: FollowingReach): boolean {
  return reach.compositionRecords.some(record => (file === `${COMPOSITION_ROOT}/${record.id}.yaml` || file === record.doc)
    && reachesAny(reach.touches, record.nodes.flatMap(node => node.path ?? [])))
}

export function isTestOrGenerated(file: string): boolean {
  return isTestScope(file) || GENERATED_PATHS.includes(file)
}

export function neverFollows(file: string, reach: FollowingReach): boolean {
  if (entryUnder(file, COMPOSITION_ROOT) && reachedRecordFollows(file, reach))
    return false
  return NEVER_FOLLOWING.some(root => entryUnder(file, root)) || coreReasonOf(file) !== undefined
}

export const FOLLOWING_TABLE: readonly FollowingRow[] = [
  { kind: 'the card\'s changeset', follows: (file, reach) => CHANGESET_FILE.test(file) && reach.added.has(file) },
  { kind: 'the command surface', follows: generatedFrom(GENERATED_FILES.surface.path, GENERATED_FILES.surface.followSources) },
  { kind: 'the factory contract', follows: generatedFrom(GENERATED_FILES.factory.path, GENERATED_FILES.factory.followSources) },
  { kind: 'the add population', follows: generatedFrom(GENERATED_FILES.addPopulation.path, GENERATED_FILES.addPopulation.followSources) },
  { kind: 'the self-hosting drift list', follows: generatedFrom(GENERATED_FILES.selfHostingDrift.path, GENERATED_FILES.selfHostingDrift.followSources) },
  { kind: 'a root self-hosting copy', follows: (file, reach) => reach.touches.some((touch) => {
    const copy = rootCopyOf(touch)
    return copy !== null && entryCovers(copy, file)
  }) },
  { kind: 'a composition record and its document', follows: reachedRecordFollows },
  { kind: 'a known violation the card removed (D-514)', follows: (file, reach) => file === KNOWN_VIOLATIONS && reach.entriesOnlyRemoved?.(file) === true },
  { kind: 'a test or a generated file', follows: (file, reach) => isTestOrGenerated(file) && !neverFollows(file, reach) },
]

export function followsTouches(file: string, reach: FollowingReach): boolean {
  return FOLLOWING_TABLE.some(row => row.follows(file, reach))
}
