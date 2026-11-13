import type { Concept } from '../../contract/factory/concepts.js'
import type { MergeFacts } from '../../policy/policy.js'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { CONCEPTS } from '../../contract/factory/concepts.js'
import { literal } from '../../contract/factory/detectors.js'
import { findSites } from '../../contract/factory/overlaps.js'
import { GENERATED_FILES, GENERATED_PATHS, NAMED_BY_THEIR_READERS, REBUILT_ON_UPDATE } from '../../core/generated-files.js'
import { mergePolicy, OWNER_MERGES_RULES } from '../../policy/policy.js'
import { followsTouches } from '../../policy/touch-scope.js'
import { cardBody } from '../bus/github-fake.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
const DEPCRUISE = path.join(REPO_ROOT, 'node_modules', 'dependency-cruiser', 'bin', 'dependency-cruiser.mjs')
const ROW = GENERATED_FILES.knownViolations
const KNOWN = ROW.path
const CRUISE_TIMEOUT_MS = 240_000
const OWNER_MERGES = readFileSync(path.join(REPO_ROOT, 'architecture', 'owner-merges.md'), 'utf8')
const READERS_BY_LITERAL = ['scripts/nodes/answer/answerer.ts', 'scripts/policy/touch-scope.ts']
const RETIRED_PENDING_TABLE = path.join(REPO_ROOT, 'scripts', 'tests', 'core', 'owner-commands-pending.json')
const TOUCHED = 'scripts/core/lease.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function room(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'known-violations-derived-'))
  roots.push(root)
  return root
}

function rebuiltInto(target: string): string {
  const args = ROW.rebuild.slice(2).map(arg => arg === KNOWN ? target : arg)
  const run = spawnSync(process.execPath, [DEPCRUISE, ...args], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  if (!existsSync(target))
    throw new Error(`depcruise wrote no baseline: ${run.stderr}`)
  return readFileSync(target, 'utf8')
}

function entry(from: string, to: string, name = 'core-imports-nothing-to-its-right'): string[] {
  return ['  {', '    "type": "dependency",', `    "from": "${from}",`, `    "to": "${to}",`, '    "rule": {', '      "severity": "error",', `      "name": "${name}"`, '    }', '  },']
}

function hunk(lines: readonly string[]): string {
  return `@@ -1,${lines.length} +1,${lines.length} @@\n${lines.join('\n')}\n`
}

const sided = (side: string, lines: readonly string[]): string[] => lines.map(line => `${side}${line}`)
const KEPT = entry('scripts/core/other.ts', 'scripts/ports/meter.ts')
const STALE = entry(TOUCHED, 'scripts/ports/meter.ts')
const GROWN = entry(TOUCHED, 'scripts/ports/github.ts')

function facts(patch: string | undefined): MergeFacts {
  return {
    cardId: 1042,
    description: cardBody(942),
    headRef: 'feat/card-1042',
    title: 'feat: card #1042',
    files: [KNOWN],
    patched: [{ filename: KNOWN, ...(patch === undefined ? {} : { patch }) }],
    ownerMergesText: OWNER_MERGES,
    shardActive: false,
    shardUnder: null,
    windowShard: null,
    decisions: [],
  }
}

describe('the known-violations list is derived from the cruise (D-536 project row R-known)', () => {
  it('the generated-files row rebuilds the list with depcruise over the cruised roots and is not rebuilt on update', () => {
    expect(ROW.rebuild).toEqual(['exec', 'depcruise', '--config', '.dependency-cruiser.mjs', '--output-type', 'baseline', '--output-to', KNOWN, 'scripts', 'src'])
    expect(ROW.followSources).toEqual(['scripts', 'src'])
    expect(REBUILT_ON_UPDATE.map(row => row.path)).not.toContain(KNOWN)
  })

  it('the committed list is byte for byte what its rebuild writes', () => {
    expect(rebuiltInto(path.join(room(), 'known.json'))).toBe(readFileSync(path.join(REPO_ROOT, KNOWN), 'utf8'))
  }, CRUISE_TIMEOUT_MS)

  it('the list is named by its readers and only by them, outside the generated-path literal detector', () => {
    expect(NAMED_BY_THEIR_READERS).toEqual([KNOWN])
    expect(GENERATED_PATHS).not.toContain(KNOWN)
    const base = CONCEPTS.find(concept => concept.id === 'generated-files')!
    const named: Concept = { ...base, detectors: [literal(text => NAMED_BY_THEIR_READERS.includes(text), 'the known-violations path by its literal')] }
    const readers = [...new Set(findSites(REPO_ROOT, [named]).map(site => site.file))].filter(file => !file.startsWith('scripts/tests/')).sort()

    expect(readers).toEqual(READERS_BY_LITERAL)
  })

  it('the list follows the touches of a card whichever way its diff goes', () => {
    const reach = { touches: [TOUCHED], added: new Set<string>(), compositionRecords: [] }

    expect(followsTouches(KNOWN, reach)).toBe(true)
    expect(followsTouches(KNOWN, { ...reach, entriesOnlyRemoved: () => false })).toBe(true)
  })

  it('a removal or a reorder of entries merges as an ordinary card', () => {
    const merging = [
      hunk([' [', ...sided(' ', KEPT), ...sided('-', STALE), ' ]']),
      hunk([' [', ...sided('-', STALE), ...sided(' ', KEPT), ...sided('+', STALE), ' ]']),
      hunk([' [', ...sided('-', KEPT), ...sided('-', STALE), ...sided('+', STALE), ...sided('+', KEPT), ' ]']),
    ]
    for (const patch of merging)
      expect(mergePolicy(facts(patch)), patch).toMatchObject({ kind: 'allowed', rule: 'auto' })
  })

  it('a new entry, an altered from, to or rule, a cycle line, a partial entry or a missing patch stays the owner\'s merge', () => {
    const growing = [
      hunk([' [', ...sided(' ', KEPT), ...sided('+', GROWN), ' ]']),
      hunk([' [', ...sided(' ', KEPT), ...sided('-', STALE), ...sided('+', GROWN), ' ]']),
      hunk([' [', ...sided(' ', KEPT), ...sided('-', STALE), ...sided('+', entry(TOUCHED, 'scripts/ports/meter.ts', 'ports-imports-nothing-to-its-right')), ' ]']),
      hunk([' [', ...sided(' ', KEPT), '+    "cycle": [', ' ]']),
      hunk([`+    "from": "${TOUCHED}",`]),
      undefined,
    ]
    for (const patch of growing)
      expect(mergePolicy(facts(patch)), String(patch)).toMatchObject({ kind: 'denied', rule: 'known_violations_grow' })
    expect(OWNER_MERGES_RULES.has('known_violations_grow')).toBe(true)
  })

  it('the pending owner-commands table is retired with no row left', () => {
    expect(existsSync(RETIRED_PENDING_TABLE)).toBe(false)
  })
})
