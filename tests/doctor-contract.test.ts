import type { ResultFamily } from '../src/commands/doctor/index.js'
import type { TemplateVars } from '../src/presets/index.js'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { CLAIM_PLACEMENTS, DOCTOR_FIELD_FAMILY, NOT_CARRIED_READINGS, RESULT_FAMILIES, runDoctor } from '../src/commands/doctor/index.js'
import { buildManifest, writeManifest } from '../src/manifest.js'
import { buildModel } from '../src/model/write.js'

const VARS: TemplateVars = {
  projectName: 'contract-fixture',
  scope: '@contract-fixture',
  nodeMajor: '22',
  contracts: 'false',
  contractPath: '',
  contractTypesOutput: '',
  compositionDir: 'architecture/composition',
  harnessCommand: 'pnpm run quality',
  packageManager: 'pnpm',
  pnpmVersion: '12.4.2',
  reviewModel: '',
  constructVersion: '0.0.0-fixture',
}

function emittedResult(): Record<string, unknown> {
  const root = mkdtempSync(path.join(tmpdir(), 'construct-contract-'))
  const content = '{ "scripts": { "quality": "pnpm lint && pnpm typecheck && pnpm test" } }'
  writeFileSync(path.join(root, 'package.json'), content)
  writeManifest(root, buildManifest({
    version: VARS.constructVersion,
    preset: 'node-backend',
    ai: 'claude',
    review: 'none',
    vars: VARS,
    written: [{ target: 'package.json', strategy: 'create', action: 'create', content }],
    contracts: false,
    previous: null,
  }))
  return runDoctor(root) as unknown as Record<string, unknown>
}

const CLI_DOC = path.resolve(import.meta.dirname, '../docs/cli.md')

function doc(): string {
  return readFileSync(CLI_DOC, 'utf8')
}

function documentedResult(): Record<string, unknown> {
  const block = [...doc().matchAll(/```json\n([\s\S]*?)```/g)]
    .map(match => match[1])
    .find(source => source.includes('"missingDiscovery"'))
  if (block == null)
    throw new Error('docs/cli.md carries no JSON example of the doctor result')
  return JSON.parse(block) as Record<string, unknown>
}

function documentedFamilies(): Record<string, string> {
  const rows = [...doc().matchAll(new RegExp(`^\\| \`(\\w+)\` \\| (${RESULT_FAMILIES.join('|')}) \\|$`, 'gm'))]
  return Object.fromEntries(rows.map(row => [row[1], row[2]]))
}

describe('doctor --json against docs/cli.md, its declared source of truth', () => {
  it('emits exactly the fields the document shows, in the order it shows them', () => {
    expect(Object.keys(emittedResult())).toEqual(Object.keys(documentedResult()))
  })

  it('shows one check per claim the model carries, in the order the model declares them', () => {
    const claims = buildModel({ vars: VARS, contracts: false, sample: true }).claims
    const checks = documentedResult().checks as { id: string, claimId: string }[]
    expect(checks.map(check => check.claimId)).toEqual(claims.map(claim => claim.id))
    for (const check of checks) {
      const claim = claims.find(entry => entry.id === check.claimId)
      expect(check.id).toBe(claim?.checkId ?? check.claimId)
    }
  })

  it('carries a family for every field, matching the classification the code declares', () => {
    expect(documentedFamilies()).toEqual(DOCTOR_FIELD_FAMILY)
    expect(new Set(Object.values(DOCTOR_FIELD_FAMILY) as ResultFamily[]).size).toBeLessThanOrEqual(RESULT_FAMILIES.length)
  })

  it('states that a harness which stopped running lint is a claim and not a problem, and does not move ok', () => {
    const prose = doc().replaceAll(/\s+/g, ' ')
    expect(prose).toContain('a harness that no longer runs lint is an unsupported claim, not a problem')
    expect(prose).toContain('No repository changes which side of `ok` it falls on')
  })

  it('explains every reading notCarried can report, so none of them is undocumented', () => {
    const prose = doc()
    for (const reading of NOT_CARRIED_READINGS)
      expect(prose, reading).toContain(`| \`${reading}\` |`)
  })

  it('explains every placement youAreHere can report, so none of the readings is undocumented', () => {
    const prose = doc()
    for (const placement of CLAIM_PLACEMENTS)
      expect(prose, placement).toContain(`| \`${placement}\` |`)
  })

  it('states that a repository with no model is an absent subject and not an obstruction, so it does not move the exit code', () => {
    const prose = doc().replaceAll(/\s+/g, ' ')
    expect(prose).toContain('nothing is known about what this repository claims')
    expect(prose).toContain('a repository with no model exits `0`, because absence of a subject is not obstruction')
  })

  it('states the boundary doctor reports from, so the blind spot is named and not synthesised', () => {
    const prose = doc().replaceAll(/\s+/g, ' ')
    expect(prose).toContain('executes nothing from the repository it inspects')
    expect(prose).toContain('does not speak about whether the harness passes')
  })
})
