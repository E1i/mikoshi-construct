import type { ReadFile, SpecifierTargets } from './specifiers.js'
import path from 'node:path'
import { parseJsonc } from './jsonc.js'
import { isRecord, strings } from './specifiers.js'

interface AliasConfig {
  paths: Record<string, string[]> | null
  pathsDirectory: string | null
  baseUrl: string | null
}

const CONFIG_FILES = ['tsconfig.json', 'jsconfig.json']
const MAX_EXTENDS_DEPTH = 16
const NO_ALIASES: AliasConfig = { paths: null, pathsDirectory: null, baseUrl: null }

function extendedFile(directory: string, extended: string, tracked: Set<string>): string | null {
  if (!extended.startsWith('.'))
    return null
  const target = path.posix.normalize(path.posix.join(directory, extended))
  return [target, `${target}.json`].find(candidate => tracked.has(candidate)) ?? null
}

function aliasesOf(compilerOptions: Record<string, unknown>): Record<string, string[]> | null {
  if (!isRecord(compilerOptions.paths))
    return null
  return Object.fromEntries(Object.entries(compilerOptions.paths).map(([pattern, substitutions]) => [pattern, strings(substitutions)]))
}

function loadConfig(file: string, tracked: Set<string>, read: ReadFile, depth: number): AliasConfig {
  const parsed = parseJsonc(read(file) ?? '')
  if (!isRecord(parsed))
    return NO_ALIASES
  const directory = path.posix.dirname(file)
  const extended = typeof parsed.extends === 'string' ? [parsed.extends] : strings(parsed.extends)
  let config = NO_ALIASES
  for (const entry of extended) {
    const target = extendedFile(directory, entry, tracked)
    if (target == null || depth >= MAX_EXTENDS_DEPTH)
      continue
    const inherited = loadConfig(target, tracked, read, depth + 1)
    config = {
      paths: inherited.paths ?? config.paths,
      pathsDirectory: inherited.paths == null ? config.pathsDirectory : inherited.pathsDirectory,
      baseUrl: inherited.baseUrl ?? config.baseUrl,
    }
  }
  const compilerOptions = isRecord(parsed.compilerOptions) ? parsed.compilerOptions : {}
  const paths = aliasesOf(compilerOptions)
  return {
    paths: paths ?? config.paths,
    pathsDirectory: paths == null ? config.pathsDirectory : directory,
    baseUrl: typeof compilerOptions.baseUrl === 'string' ? path.posix.normalize(path.posix.join(directory, compilerOptions.baseUrl)) : config.baseUrl,
  }
}

function captured(pattern: string, specifier: string): string | null {
  const star = pattern.indexOf('*')
  if (star === -1)
    return pattern === specifier ? '' : null
  const prefix = pattern.slice(0, star)
  const suffix = pattern.slice(star + 1)
  const fits = specifier.length >= prefix.length + suffix.length && specifier.startsWith(prefix) && specifier.endsWith(suffix)
  return fits ? specifier.slice(prefix.length, specifier.length - suffix.length) : null
}

function matchingPattern(paths: Record<string, string[]>, specifier: string): string | null {
  const matching = Object.keys(paths).filter(pattern => captured(pattern, specifier) != null)
  const exact = matching.find(pattern => !pattern.includes('*'))
  return exact ?? matching.sort((left, right) => right.indexOf('*') - left.indexOf('*'))[0] ?? null
}

function aliasTargets(config: AliasConfig, specifier: string): string[] | null {
  const base = config.baseUrl ?? config.pathsDirectory
  if (config.paths == null || base == null)
    return null
  const pattern = matchingPattern(config.paths, specifier)
  if (pattern == null)
    return null
  const wildcard = captured(pattern, specifier) ?? ''
  return config.paths[pattern].map(substitution => path.posix.normalize(path.posix.join(base, substitution.replace('*', wildcard))))
}

function nearestConfig(from: string, tracked: Set<string>): string | null {
  let directory = path.posix.dirname(from)
  while (true) {
    const found = CONFIG_FILES.map(name => path.posix.join(directory, name)).find(candidate => tracked.has(candidate))
    if (found !== undefined)
      return found
    if (directory === '.')
      return null
    directory = path.posix.dirname(directory)
  }
}

export function readPathAliases(tracked: Set<string>, read: ReadFile): SpecifierTargets {
  const configs = new Map<string, AliasConfig>()
  return (from, specifier) => {
    const file = nearestConfig(from, tracked)
    if (file == null)
      return null
    const config = configs.get(file) ?? loadConfig(file, tracked, read, 0)
    configs.set(file, config)
    return aliasTargets(config, specifier)
  }
}
