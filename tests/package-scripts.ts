import { readFileSync } from 'node:fs'
import path from 'node:path'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')

export function packageScripts(): Record<string, string> {
  const manifest = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
  return manifest.scripts
}

export function resolvedScript(name: string, table: Record<string, string>, seen = new Set<string>()): string {
  if (seen.has(name))
    return ''
  seen.add(name)
  const body = table[name] ?? ''
  return [body, ...[...body.matchAll(/pnpm (?:run )?([\w:-]+)/g)].map(match => resolvedScript(match[1], table, seen))].join(' ')
}

export function reachedByHarness(table = packageScripts()): Set<string> {
  const seen = new Set<string>()
  resolvedScript('quality', table, seen)
  return seen
}

export function onTheHarnessRoute(table = packageScripts()): Set<string> {
  const reached = reachedByHarness(table)
  const route = new Set(reached)
  for (const name of Object.keys(table)) {
    const seen = new Set<string>()
    resolvedScript(name, table, seen)
    if (seen.has('quality'))
      route.add(name)
  }
  return route
}
