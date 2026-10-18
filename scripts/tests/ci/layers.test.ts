import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
const DEPCRUISE = path.join(REPO_ROOT, 'node_modules', 'dependency-cruiser', 'bin', 'dependency-cruiser.mjs')
const LAYER_CONFIG = path.join(REPO_ROOT, '.dependency-cruiser.mjs')
const LAYERS_CHECK = 'depcruise --config .dependency-cruiser.mjs --ignore-known .dependency-cruiser-known-violations.json scripts src'
const CRUISE_TIMEOUT_MS = 120_000

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

interface Cruise { status: number | null, violations: string[] }

function depcruise(cwd: string, args: string[]): Cruise {
  const check = spawnSync(process.execPath, [DEPCRUISE, ...args], { cwd, encoding: 'utf8' })
  const run = spawnSync(process.execPath, [DEPCRUISE, ...args, '--output-type', 'json'], { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  if (run.stdout === '')
    throw new Error(`depcruise printed no result: ${run.stderr}`)
  const result = JSON.parse(run.stdout) as { summary: { violations: { rule: { name: string, severity: string }, from: string, to: string }[] } }
  return {
    status: check.status,
    violations: result.summary.violations
      .filter(violation => violation.rule.severity !== 'ignore')
      .map(violation => `${violation.rule.name} ${violation.from} -> ${violation.to}`),
  }
}

function sampleTree(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'layers-'))
  roots.push(root)
  for (const [file, text] of Object.entries({ 'tsconfig.json': '{}\n', ...files })) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    writeFileSync(path.join(root, file), text)
  }
  return root
}

function packageScripts(): Record<string, string> {
  return (JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts
}

describe('the layer rules of the bus hold over scripts and src', () => {
  it('runs the layer check against the recorded baseline in the harness', () => {
    expect(packageScripts()['layers:check']).toBe(LAYERS_CHECK)
  })

  it('finds no layer violation in this repository beyond the recorded baseline', () => {
    expect(depcruise(REPO_ROOT, LAYERS_CHECK.split(' ').slice(1))).toEqual({ status: 0, violations: [] })
  }, CRUISE_TIMEOUT_MS)

  it('refuses an import from the bus core into a service module', () => {
    const root = sampleTree({
      'scripts/bus/db.ts': 'import { review } from \'./review-worker.js\'\nexport const db = review\n',
      'scripts/bus/review-worker.ts': 'export const review = 1\n',
    })
    expect(depcruise(root, ['--config', LAYER_CONFIG, 'scripts'])).toEqual({ status: 1, violations: ['bus-core-imports-no-service scripts/bus/db.ts -> scripts/bus/review-worker.ts'] })
  }, CRUISE_TIMEOUT_MS)

  it('refuses an import from one service into another, and lets a service import its own executor', () => {
    const root = sampleTree({
      'scripts/bus/merge-worker.ts': 'import { review } from \'./review-executor.js\'\nimport { merge } from \'./merge-executor.js\'\nexport const worker = [review, merge]\n',
      'scripts/bus/merge-executor.ts': 'export const merge = 1\n',
      'scripts/bus/review-executor.ts': 'export const review = 1\n',
    })
    expect(depcruise(root, ['--config', LAYER_CONFIG, 'scripts'])).toEqual({ status: 1, violations: ['bus-services-import-no-other-service scripts/bus/merge-worker.ts -> scripts/bus/review-executor.ts'] })
  }, CRUISE_TIMEOUT_MS)

  it('refuses an import from the product into the factory scripts', () => {
    const root = sampleTree({
      'src/cli.ts': 'import { bus } from \'../scripts/bus/db.js\'\nexport const cli = bus\n',
      'scripts/bus/db.ts': 'export const bus = 1\n',
    })
    expect(depcruise(root, ['--config', LAYER_CONFIG, 'src', 'scripts'])).toEqual({ status: 1, violations: ['src-imports-no-script src/cli.ts -> scripts/bus/db.ts'] })
  }, CRUISE_TIMEOUT_MS)
})
