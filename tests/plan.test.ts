import type { TemplateVars } from '../src/presets/index.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { planMaterialize } from '../src/materialize/plan.js'

const vars: TemplateVars = {
  projectName: 'shop',
  scope: '@shop',
  nodeMajor: '22',
  contracts: 'true',
  contractPath: 'contracts/api/openapi.yaml',
  contractTypesOutput: 'src/contracts/openapi.ts',
  contractTypesImport: './openapi.js',
  contractPathFromConfig: '../contracts/api/openapi.yaml',
  appRoot: '',
  harnessCommand: 'pnpm run quality',
  packageManager: 'pnpm',
  pnpmVersion: '12.0.0',
  reviewModel: 'claude-sonnet-5',
  constructVersion: '0.0.0',
}

function scratch(): string {
  return mkdtempSync(path.join(tmpdir(), 'construct-plan-'))
}

describe('planMaterialize', () => {
  it('mounts a group under a prefix', () => {
    const plan = planMaterialize(scratch(), [{ group: 'stacks/express-api/app', into: 'apps/api' }], vars, { emptyTarget: true, ai: 'claude' })
    const targets = plan.ops.map(op => op.target)
    expect(targets).toContain('apps/api/src/app.ts')
    expect(targets.every(target => target.startsWith('apps/api/'))).toBe(true)
    expect(plan.omittedGroups).toEqual([])
  })

  it('omits sample groups when the directory is not empty and says which', () => {
    const plan = planMaterialize(scratch(), ['stacks/http-contract', { group: 'stacks/express-api/app', onlyWhenEmpty: true }], vars, { emptyTarget: false, ai: 'claude' })
    const targets = plan.ops.map(op => op.target)
    expect(targets).toContain('contracts/api/openapi.yaml')
    expect(targets).not.toContain('src/app.ts')
    expect(plan.omittedGroups).toEqual(['stacks/express-api/app'])
  })

  it('layers package.json groups into the canonical key order with sorted dependencies', () => {
    const plan = planMaterialize(scratch(), ['harness', 'stacks/http-contract'], vars, { emptyTarget: true, ai: 'claude' })
    const manifest = plan.ops.find(op => op.target === 'package.json')
    const parsed = JSON.parse(manifest?.content ?? '{}') as Record<string, unknown>
    const keys = Object.keys(parsed)
    expect(keys.indexOf('packageManager')).toBeLessThan(keys.indexOf('scripts'))
    expect(keys.indexOf('scripts')).toBeLessThan(keys.indexOf('devDependencies'))
    expect(parsed.packageManager).toBe('pnpm@12.0.0')
    expect((parsed.scripts as Record<string, string>).quality).toContain('contracts:check')
    expect(Object.keys(parsed.devDependencies as Record<string, string>)).toEqual([...Object.keys(parsed.devDependencies as Record<string, string>)].sort((a, b) => a.localeCompare(b)))
  })
})
