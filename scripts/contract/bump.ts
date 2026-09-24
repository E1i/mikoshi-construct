import type { BumpLevel } from './declared.js'
import type { ChangeLevel, SurfaceReading } from './semantic-diff.js'
import type { Surface } from './surface.js'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { BUMP_LEVELS, declaredLevel, headVersion } from './declared.js'
import { requiredChange, SECTIONS, UNBASELINED } from './semantic-diff.js'
import { SURFACE_VERSION } from './surface.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')
const SURFACE_FILE = 'contract/surface.json'
const UNVERSIONED_SURFACE = 1

export interface BaseReading {
  reading: SurfaceReading
  note: string
}

export function baseTag(root: string): string {
  return execFileSync('git', ['describe', '--tags', '--abbrev=0', '--match', 'v*', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
}

function tagSurface(root: string, tag: string): unknown {
  try {
    return JSON.parse(execFileSync('git', ['show', `${tag}:${SURFACE_FILE}`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })) as unknown
  }
  catch {
    return null
  }
}

function surfaceVersionOf(recorded: object): number {
  return 'surfaceVersion' in recorded && typeof recorded.surfaceVersion === 'number' ? recorded.surfaceVersion : UNVERSIONED_SURFACE
}

function wholeBaseUnbaselined(): SurfaceReading {
  return Object.fromEntries(SECTIONS.map(section => [section, UNBASELINED])) as SurfaceReading
}

export function baseReading(recorded: unknown, tag: string): BaseReading {
  if (recorded == null || typeof recorded !== 'object')
    return { reading: wholeBaseUnbaselined(), note: `${tag} carries no ${SURFACE_FILE}: the whole base is unbaselined` }
  const version = surfaceVersionOf(recorded)
  if (version !== SURFACE_VERSION)
    return { reading: wholeBaseUnbaselined(), note: `${tag} carries ${SURFACE_FILE} of surfaceVersion ${version}, this generator writes ${SURFACE_VERSION}: the whole base is unbaselined` }
  return { reading: recorded as SurfaceReading, note: `${tag} carries ${SURFACE_FILE} of surfaceVersion ${SURFACE_VERSION}: it is the base` }
}

export function requiredLevel(change: ChangeLevel, version: string): BumpLevel {
  const beforeOne = Number(version.split('.')[0]) === 0
  if (change === 'none')
    return 'none'
  if (change === 'additive')
    return beforeOne ? 'patch' : 'minor'
  return beforeOne ? 'minor' : 'major'
}

export function isWeaker(declared: BumpLevel, required: BumpLevel): boolean {
  return BUMP_LEVELS.indexOf(declared) < BUMP_LEVELS.indexOf(required)
}

function run(root: string): number {
  const tag = baseTag(root)
  const base = baseReading(tagSurface(root, tag), tag)
  const head = JSON.parse(readFileSync(path.join(root, SURFACE_FILE), 'utf8')) as Surface
  const change = requiredChange(base.reading, head)
  const required = requiredLevel(change.level, headVersion(root))
  const declared = declaredLevel(root, tag)
  const lines = [
    `[contract:bump] base ${tag}: ${base.note}`,
    `required: ${required} (${change.level} surface change)`,
    `declared: ${declared}`,
    ...change.reasons.map(reason => `  ${reason}`),
  ]
  if (isWeaker(declared, required)) {
    console.error([...lines, `declared ${declared} is weaker than required ${required}: add a changeset of level ${required} for mikoshi-construct`].join('\n'))
    return 1
  }
  console.warn(lines.join('\n'))
  return 0
}

if (process.argv[1]?.endsWith('bump.ts'))
  process.exit(run(REPO_ROOT))
