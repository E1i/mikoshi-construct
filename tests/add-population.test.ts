import type { PresetId, TemplateVars } from '../src/presets/index.js'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { detect } from '../src/detect/index.js'
import { planMaterialize } from '../src/materialize/plan.js'
import { aiGroups, getPreset, PRESET_IDS } from '../src/presets/index.js'

const ENTRY_HEADING = '## 2026-09-21 · The `add` population, named before anything is done about it'
const OBSERVATIONS = path.resolve(import.meta.dirname, '../architecture/observations.md')

const VARS: TemplateVars = {
  projectName: 'population-fixture',
  scope: '@population-fixture',
  nodeMajor: '22',
  contracts: 'false',
  contractPath: 'contracts/api/openapi.yaml',
  contractTypesOutput: 'src/contracts/openapi.ts',
  compositionDir: 'architecture/composition',
  harnessCommand: 'pnpm run quality',
  packageManager: 'pnpm',
  pnpmVersion: '12.4.2',
  reviewModel: 'claude-sonnet-5',
  constructVersion: '0.0.0-fixture',
}

function producedFor(presetId: PresetId, emptyTarget: boolean): string[] {
  const dir = mkdtempSync(path.join(tmpdir(), 'construct-population-'))
  const preset = getPreset(presetId)
  const vars = { ...VARS, contracts: preset.contracts ? 'true' : 'false', ...preset.vars(detect(dir), VARS.projectName) }
  const plan = planMaterialize(dir, [...preset.groups, ...aiGroups('claude')], vars, { emptyTarget, ai: 'claude' })
  return plan.ops.map(op => op.target)
}

function acrossPresets(emptyTarget: boolean): Set<string> {
  const produced = new Set<string>()
  for (const presetId of PRESET_IDS) {
    if (!getPreset(presetId).available)
      continue
    for (const target of producedFor(presetId, emptyTarget))
      produced.add(target)
  }
  return produced
}

function entry(): string {
  const document = readFileSync(OBSERVATIONS, 'utf8')
  const start = document.indexOf(ENTRY_HEADING)
  if (start === -1)
    throw new Error(`architecture/observations.md carries no entry headed "${ENTRY_HEADING}"`)
  const next = document.indexOf('\n## ', start + ENTRY_HEADING.length)
  return document.slice(start, next === -1 ? undefined : next)
}

function pathsNamedInEntry(): Set<string> {
  const looksLikeAPath = /^[\w.@][\w./-]*\.\w+$|^\.[\w.-]+$/
  return new Set(
    [...entry().matchAll(/`([^`]+)`/g)]
      .map(match => match[1])
      .filter(candidate => looksLikeAPath.test(candidate)),
  )
}

const ITS_OWN_NAME = 'tests/add-population.test.ts'

function asOneLine(): string {
  return entry().replace(/\s+/g, ' ')
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort()
}

describe('the add population is partitioned in the record, not selected from', () => {
  const reachesAnyTree = acrossPresets(false)
  const emptyOnly = sorted([...acrossPresets(true)].filter(target => !reachesAnyTree.has(target)))
  const named = pathsNamedInEntry()

  it('names every path that is written into a tree the construct did not create', () => {
    const unclassified = sorted([...reachesAnyTree].filter(target => !named.has(target)))

    expect(unclassified, 'paths produced for an adopted tree and absent from the entry').toEqual([])
  })

  it('names no path the presets do not produce, so the record cannot drift ahead of the code', () => {
    const produced = new Set([...reachesAnyTree, ...emptyOnly])
    const invented = sorted([...named].filter(target => !produced.has(target) && target.includes('/') && target !== ITS_OWN_NAME))

    expect(invented, 'paths named in the entry that no preset produces').toEqual([])
  })

  it('states the counts the partition rests on, so a new template moves the record', () => {
    const text = asOneLine()

    expect(text).toContain(`${new Set([...reachesAnyTree, ...emptyOnly]).size} distinct paths`)
    expect(text).toContain(`${emptyOnly.length} of them are reached only in an empty directory`)
    expect(text).toContain(`The remaining ${reachesAnyTree.size} are written into any tree`)
  })

  it('keeps the only existing conditionality the one the record describes', () => {
    expect(emptyOnly.length).toBeGreaterThan(0)
    expect(emptyOnly.every(target => !reachesAnyTree.has(target))).toBe(true)
  })

  it('reports rather than repairs: the entry names the two granularities and settles neither question', () => {
    const text = asOneLine()

    expect(text).toContain('two granularities')
    expect(text).toContain('is not settled here')
  })
})
