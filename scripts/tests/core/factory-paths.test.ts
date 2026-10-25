import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { builtEntryOf } from '../../supervisor/bg.js'
import { SUPERVISOR_LAUNCH } from '../../supervisor/supervisor.js'
import { busLaunches } from '../../supervisor/workers.js'
import { FACTORY_FOLDERS, FACTORY_FORMER_FOLDERS, FACTORY_NAMED, FACTORY_PATH_EXCLUSIONS, FACTORY_PATH_ROOTS, FACTORY_ROOT, FACTORY_RUNTIME, FACTORY_WORKERS, inScopes, scopeOf } from '../../core/factory-paths.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
const REGISTRY = 'scripts/core/factory-paths.ts'
const FACTORY_SOURCE_ROOTS = [FACTORY_ROOT, 'src']
const FACTORY_SOURCE_FILES = ['tsup.config.ts']
const NOT_YET_MIGRATED = [
  'src/commands/intake/admit.ts',
  'scripts/nodes/launch/overlap.ts',
]
const HOOK_SCRIPT = /\.claude\/hooks\/[\w-]+\.mjs/g
const FACTORY_SCRIPT = /^node --import tsx (\S+\.ts)(?:\s|$)/
const TABLE_ONLY = ['architecture/owner-merges.md']
const CARRIERS = [
  'package.json',
  'scripts/ci/test-weights.json',
  FACTORY_RUNTIME.layerMap,
  FACTORY_RUNTIME.knownLivenessSites,
  FACTORY_NAMED.knownProjectionWrites,
  FACTORY_NAMED.knownGhCallers,
  'architecture/owner-merges.md',
  'architecture/ghosts-files.md',
  'architecture/security-invariants.md',
  'architecture/contours.md',
  'CONTRIBUTING.md',
  '.claude/agents/review.md',
  '.claude/rules/templates.md',
  '.dependency-cruiser.mjs',
  'eslint.config.mjs',
]

function tracked(): string[] {
  return execFileSync('git', ['-C', REPO_ROOT, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' })
    .split('\0')
    .filter(file => file !== '' && existsSync(path.join(REPO_ROOT, file)))
}

function matches(pattern: string, file: string): boolean {
  return pattern.endsWith('/**') ? file.startsWith(pattern.slice(0, -2)) : file === pattern
}

function excluded(file: string): boolean {
  return Object.values(FACTORY_PATH_EXCLUSIONS).some(patterns => patterns.some(pattern => matches(pattern, file)))
}

function escaped(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function literalPattern(form: string): RegExp {
  return /\.\w+$/.test(form)
    ? new RegExp(`(?<![\\w./-])${escaped(form)}(?![\\w-])`)
    : new RegExp(`['"\`]${escaped(form)}/?(?:['"\`]|\\$\\{)`)
}

function segmentPattern(file: string): RegExp {
  return new RegExp(file.split('/').map(segment => `['"\`]${escaped(segment)}['"\`]`).join('\\s*,\\s*'))
}

function registryPaths(): string[] {
  const folders = Object.entries(FACTORY_FOLDERS).flatMap(([id, values]) => id === 'entries' ? values.map(name => `${FACTORY_ROOT}/${name}`) : values)
  return [...new Set([...Object.values(FACTORY_RUNTIME), ...Object.values(FACTORY_WORKERS), ...Object.values(FACTORY_NAMED), ...folders, ...Object.values(FACTORY_FORMER_FOLDERS).flat()])]
}

function pathsNamedIn(carrier: string, text: string): string[] {
  const roots = FACTORY_PATH_ROOTS.join('|')
  const lines = TABLE_ONLY.includes(carrier) ? text.split('\n').filter(line => line.startsWith('|')).join('\n') : text
  return [...new Set([...lines.matchAll(new RegExp(`(?<![\\w./-])((?:${roots})/[\\w./-]*\\w)(?![\\w\\\\-])`, 'g'))].map(([, named]) => named!))].filter(named => !excluded(named))
}

describe('the factory path registry', () => {
  it('every path the factory registry names exists', () => {
    expect(registryPaths().filter(file => !existsSync(path.join(REPO_ROOT, file)))).toEqual([])
  })

  it('no factory source names a factory path except the registry', () => {
    const named = registryPaths().filter(file => file !== FACTORY_ROOT)
    const sources = tracked().filter(file => file.endsWith('.ts') && file !== REGISTRY && !NOT_YET_MIGRATED.includes(file) && !excluded(file)
      && (FACTORY_SOURCE_FILES.includes(file) || FACTORY_SOURCE_ROOTS.some(root => file.startsWith(`${root}/`))))
    expect(sources).toContain('scripts/supervisor/bg.ts')
    expect(NOT_YET_MIGRATED.every(file => existsSync(path.join(REPO_ROOT, file)))).toBe(true)
    const patterns = named.flatMap(file => [file, file.replace(/\.\w+$/, '')].map(form => literalPattern(form)).concat(segmentPattern(file)))
    expect(sources.flatMap((source) => {
      const text = readFileSync(path.join(REPO_ROOT, source), 'utf8')
      return patterns.filter(pattern => pattern.test(text)).map(pattern => `${source}: ${pattern.source}`)
    })).toEqual([])
  })

  it('every factory path a carrier names exists', () => {
    const swept = tracked().filter(file => !excluded(file) && (/^architecture\/composition\/[\w-]+\.yaml$/.test(file) || /^docs\/.+\.md$/.test(file)))
    expect(swept.length).toBeGreaterThan(0)
    expect([...CARRIERS, ...swept].flatMap((carrier) => {
      const text = readFileSync(path.join(REPO_ROOT, carrier), 'utf8')
      return pathsNamedIn(carrier, text).filter(named => !existsSync(path.join(REPO_ROOT, named))).map(named => `${carrier}: ${named}`)
    })).toEqual([])
  })

  it('every script a hook spawns exists', () => {
    const settings = readFileSync(path.join(REPO_ROOT, '.claude', 'settings.json'), 'utf8')
    const hooks = [...settings.matchAll(HOOK_SCRIPT)].map(([hook]) => hook)
    expect(hooks.length).toBeGreaterThan(0)
    expect(hooks.filter(hook => !existsSync(path.join(REPO_ROOT, hook)))).toEqual([])
    const scripts = (JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts
    const launches = [...busLaunches(() => []), SUPERVISOR_LAUNCH]
    const spawned = launches.map((launch) => {
      const source = FACTORY_SCRIPT.exec(scripts[launch.script] ?? '')?.[1]
      return { launch, source, built: builtEntryOf(REPO_ROOT, launch.script) }
    })
    expect(spawned.filter(({ source }) => source === undefined || !existsSync(path.join(REPO_ROOT, source)))).toEqual([])
    expect(spawned.filter(({ launch, source }) => !launch.markers.some(marker => marker.startsWith(`${source} `) || marker === source))).toEqual([])
    expect(spawned.filter(({ source, built }) => path.relative(path.join(REPO_ROOT, 'dist'), built).replace(/\.js$/, '.ts') !== source)).toEqual([])
  })

  it('a folder entry scopes everything under it and a file entry scopes only itself', () => {
    expect(scopeOf('scripts/ladder')).toBe('scripts/ladder/')
    expect(scopeOf('scripts/ladder/session.ts')).toBe('scripts/ladder/session.ts')
    const entries = ['scripts/shift', 'scripts/ladder/session.ts']
    expect(inScopes('scripts/shift/bg.ts', entries)).toBe(true)
    expect(inScopes('scripts/ladder/session.ts', entries)).toBe(true)
    expect(inScopes('scripts/ladder/session.test.ts', entries)).toBe(false)
    expect(inScopes('scripts/shifted.ts', entries)).toBe(false)
    expect(inScopes('scripts/shift', entries)).toBe(false)
  })

  it('every excluded class matches a tracked file', () => {
    const files = tracked()
    expect(Object.entries(FACTORY_PATH_EXCLUSIONS).filter(([, patterns]) => !files.some(file => patterns.some(pattern => matches(pattern, file)))).map(([name]) => name)).toEqual([])
  })
})
