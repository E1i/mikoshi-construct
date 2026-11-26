import type { DatabaseSync } from 'node:sqlite'
import { existsSync, lstatSync, readdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { appendEvent } from '../../core/db.js'
import { events } from '../../core/events-query.js'
import { ARTIFACT_REMOVED, BOARD_ALARM, CARD_CLOSED } from '../../core/events.js'
import { failureOf } from './close-executor.js'

export type ArtifactBase = 'home' | 'bus'

export type ArtifactEnd
  = | 'card ended'
    | 'verdict recorded'
    | 'probe closed, only its report stays'
    | 'term passed'
    | 'kept as the closing record'

export interface ArtifactLifetime {
  kind: string
  base: ArtifactBase
  segments: readonly string[]
  owner: string
  end: ArtifactEnd
}

export const CARD_TREES = 'card trees'
export const CARD_TREES_BEFORE_THE_BUS = 'card trees before the bus'
export const REVIEW_TREES = 'review trees'
export const DRY_RUN_TREES = 'dry-run review trees'
export const PROBES = 'probes'
export const REPORTS = 'reports'
export const ENDED_TREE_PATCHES = 'ended card tree patches'

export const ARTIFACT_LIFETIMES: readonly ArtifactLifetime[] = [
  { kind: CARD_TREES, base: 'bus', segments: ['worktrees'], owner: 'close', end: 'card ended' },
  { kind: CARD_TREES_BEFORE_THE_BUS, base: 'home', segments: ['worktrees'], owner: 'close', end: 'card ended' },
  { kind: REVIEW_TREES, base: 'bus', segments: ['reviews'], owner: 'review', end: 'verdict recorded' },
  { kind: DRY_RUN_TREES, base: 'bus', segments: ['dry-run-reviews'], owner: 'close', end: 'verdict recorded' },
  { kind: PROBES, base: 'home', segments: ['probes'], owner: 'close', end: 'probe closed, only its report stays' },
  { kind: REPORTS, base: 'home', segments: ['reports'], owner: 'close', end: 'kept as the closing record' },
  { kind: ENDED_TREE_PATCHES, base: 'bus', segments: ['probes', 'ended-trees'], owner: 'close', end: 'term passed' },
]

export const ENDED_TREE_PATCH_DAYS = 30
export const HOME_BUDGET_BYTES = 40 * 1024 ** 3
export const HOME_OVER_BUDGET = 'home_over_budget'
const DAY_MS = 24 * 60 * 60 * 1000
const LISTED_ROOTS = 5
const DRY_RUN_RECORD = '.dry-run.json'
const PROBE_DIRECTORY = /^(\d+)(?:-|$)/

export interface ConstructPlaces {
  home: string
  busDir: string
}

export function lifetimeOf(kind: string): ArtifactLifetime {
  const row = ARTIFACT_LIFETIMES.find(each => each.kind === kind)
  if (row === undefined)
    throw new Error(`no artifact lifetime row for ${kind}`)
  return row
}

export function rootOf(row: ArtifactLifetime, places: ConstructPlaces): string {
  return path.join(row.base === 'home' ? places.home : places.busDir, ...row.segments)
}

export function rootOfKind(kind: string, places: ConstructPlaces): string {
  return rootOf(lifetimeOf(kind), places)
}

export function rowOfRoot(root: string, places: ConstructPlaces): ArtifactLifetime | null {
  const wanted = path.resolve(root)
  return ARTIFACT_LIFETIMES.find(row => path.resolve(rootOf(row, places)) === wanted) ?? null
}

export interface TreeRemover {
  remove: (tree: string) => void
  removeDirectory: (tree: string) => void
  prune: () => void
}

export interface FreedArtifact {
  kind: string
  path: string
  left: string | null
}

function directoriesIn(root: string): string[] {
  if (!existsSync(root))
    return []
  return readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name)
}

function removedOrLeft(remove: () => void): string | null {
  try {
    remove()
    return null
  }
  catch (error) {
    return failureOf(error)
  }
}

export function freeDryRunTrees(places: ConstructPlaces, git: TreeRemover): FreedArtifact[] {
  const root = rootOfKind(DRY_RUN_TREES, places)
  const freed = directoriesIn(root).filter(name => existsSync(path.join(root, `${name}${DRY_RUN_RECORD}`))).map((name) => {
    const tree = path.join(root, name)
    const gitSaid = removedOrLeft(() => git.remove(tree))
    const left = gitSaid === null ? null : removedOrLeft(() => git.removeDirectory(tree))
    return { kind: DRY_RUN_TREES, path: tree, left: left === null ? null : `${gitSaid}; ${left}` }
  })
  if (freed.length > 0)
    removedOrLeft(() => git.prune())
  return freed
}

function closedProbeReports(db: DatabaseSync): Map<number, string> {
  const reports = new Map<number, string>()
  for (const row of events(db, { types: [CARD_CLOSED], withCard: true })) {
    const report = row.data?.report
    if (typeof report === 'string' && report !== '' && row.card_id !== null)
      reports.set(row.card_id, report)
  }
  return reports
}

function inside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

function allButReport(directory: string, report: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const entry = path.join(directory, name)
    if (entry === report)
      return []
    if (inside(entry, report))
      return allButReport(entry, report)
    return [entry]
  })
}

export function freeClosedProbes(db: DatabaseSync, places: ConstructPlaces): FreedArtifact[] {
  const root = rootOfKind(PROBES, places)
  const reports = closedProbeReports(db)
  return directoriesIn(root).flatMap((name) => {
    const cardId = PROBE_DIRECTORY.exec(name)?.[1]
    const report = cardId === undefined ? undefined : reports.get(Number(cardId))
    const probe = path.join(root, name)
    if (report === undefined || !inside(probe, path.resolve(report)))
      return []
    return allButReport(probe, path.resolve(report)).map(copy => ({ kind: PROBES, path: copy, left: removedOrLeft(() => rmSync(copy, { recursive: true, force: true })) }))
  })
}

export function freeExpiredPatches(places: ConstructPlaces, now: Date): FreedArtifact[] {
  const root = rootOfKind(ENDED_TREE_PATCHES, places)
  const term = now.getTime() - ENDED_TREE_PATCH_DAYS * DAY_MS
  return directoriesIn(root).map(name => path.join(root, name)).filter(saved => lstatSync(saved).mtimeMs < term).map(saved => ({ kind: ENDED_TREE_PATCHES, path: saved, left: removedOrLeft(() => rmSync(saved, { recursive: true, force: true })) }))
}

export function sweepArtifacts(db: DatabaseSync, places: ConstructPlaces, git: TreeRemover, now: Date): FreedArtifact[] {
  return [...freeDryRunTrees(places, git), ...freeClosedProbes(db, places), ...freeExpiredPatches(places, now)]
}

export function recordFreedArtifacts(db: DatabaseSync, actor: string, ts: string, freed: FreedArtifact[]): void {
  for (const artifact of freed) {
    if (artifact.left === null)
      appendEvent(db, { ts, type: ARTIFACT_REMOVED, actor, cardId: null, pr: null, head: null, dedupeKey: `${ARTIFACT_REMOVED}:${artifact.path}:${ts}`, payload: { path: artifact.path, by: actor }, legacy: false })
    else
      appendEvent(db, { ts, type: BOARD_ALARM, actor, cardId: null, pr: null, head: null, dedupeKey: `${BOARD_ALARM}:artifact_left:${artifact.path}:${ts.slice(0, 10)}`, payload: { reason: 'artifact_left', path: artifact.path, detail: `${artifact.kind}: ${artifact.left}` }, legacy: false })
  }
}

function sizeOf(where: string): number {
  let stat
  try {
    stat = lstatSync(where)
  }
  catch {
    return 0
  }
  if (!stat.isDirectory())
    return stat.size
  let names: string[]
  try {
    names = readdirSync(where)
  }
  catch {
    return 0
  }
  return names.reduce((total, name) => total + sizeOf(path.join(where, name)), 0)
}

export interface RootSize {
  path: string
  bytes: number
}

export function rootSizes(home: string): RootSize[] {
  if (!existsSync(home))
    return []
  return readdirSync(home).map(name => ({ path: path.join(home, name), bytes: sizeOf(path.join(home, name)) })).sort((a, b) => b.bytes - a.bytes)
}

function gib(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`
}

export function overBudgetLine(sizes: RootSize[], budget: number): string | null {
  const total = sizes.reduce((sum, root) => sum + root.bytes, 0)
  if (total <= budget)
    return null
  return `${gib(total)} over the budget of ${gib(budget)}; largest roots: ${sizes.slice(0, LISTED_ROOTS).map(root => `${root.path} ${gib(root.bytes)}`).join(', ')}`
}

export function alarmOverBudget(db: DatabaseSync, actor: string, ts: string, home: string, budget: number = HOME_BUDGET_BYTES, sizes: (home: string) => RootSize[] = rootSizes): string | null {
  const line = overBudgetLine(sizes(home), budget)
  if (line !== null)
    appendEvent(db, { ts, type: BOARD_ALARM, actor, cardId: null, pr: null, head: null, dedupeKey: `${BOARD_ALARM}:${HOME_OVER_BUDGET}:${home}:${ts.slice(0, 10)}`, payload: { reason: HOME_OVER_BUDGET, path: home, detail: line }, legacy: false })
  return line
}
