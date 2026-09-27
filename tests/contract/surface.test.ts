import type { Surface } from '../../scripts/contract/surface.js'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { generateSurface, renderSurface } from '../../scripts/contract/surface.js'
import { REPORT_FORMATS } from '../../src/commands/mutate/index.js'
import { AI_TARGETS, PRESET_IDS, REVIEW_PROVIDERS } from '../../src/presets/index.js'

const RECORDED = path.resolve(import.meta.dirname, '../../contract/surface.json')

const ENUMERABLE_FLAG_OPTIONS: Record<string, readonly string[]> = {
  'init preset': PRESET_IDS,
  'init ai': AI_TARGETS,
  'init review': REVIEW_PROVIDERS,
  'attach ai': AI_TARGETS,
  'mutate judge format': REPORT_FORMATS,
}

let generatedSurface: Surface | undefined

function generated(): Surface {
  generatedSurface ??= generateSurface()
  return generatedSurface
}

function recordedOptions(surface: Surface): Record<string, string[]> {
  return Object.fromEntries(Object.entries(surface.commands).flatMap(([name, command]) =>
    'flags' in command ? Object.entries(command.flags).flatMap(([flag, declared]) => declared.options == null ? [] : [[`${name} ${flag}`, declared.options]]) : []))
}

function leaves(value: unknown, at = ''): Map<string, string> {
  if (value != null && typeof value === 'object')
    return new Map(Object.entries(value).flatMap(([key, child]) => [...leaves(child, at === '' ? key : `${at}.${key}`)]))
  return new Map([[at, JSON.stringify(value)]])
}

function changedPaths(generated: string, recorded: string): string[] {
  const now = leaves(JSON.parse(generated))
  const then = leaves(JSON.parse(recorded))
  return [...new Set([...now.keys(), ...then.keys()])].filter(key => now.get(key) !== then.get(key)).sort()
}

describe('contract/surface.json records the surface the generator observes', () => {
  it('matches the generated surface byte for byte; the test compares and never writes', () => {
    const rendered = renderSurface(generated())
    const recorded = readFileSync(RECORDED, 'utf8')
    const changed = changedPaths(rendered, recorded)

    expect(changed, `the command-line surface changed at ${changed.join(', ')}: run \`pnpm contract:update\` and put its diff in the pull request`).toEqual([])
    expect(rendered, 'contract/surface.json differs in layout only: run `pnpm contract:update`').toBe(recorded)
  }, 180_000)

  it('records the options of every enumerable flag, taken from the constant that holds them', () => {
    expect(recordedOptions(generated())).toEqual(Object.fromEntries(Object.entries(ENUMERABLE_FLAG_OPTIONS).map(([key, options]) => [key, [...options]])))
  }, 180_000)
})
