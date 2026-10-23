import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { layerIn, layerOf, selectRun } from '../../ci/layers.js'
import { cruise } from '../../ci/select.js'
import { readLayerMap } from '../../core/layer-map.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
const DEPCRUISE = path.join(REPO_ROOT, 'node_modules', 'dependency-cruiser', 'bin', 'dependency-cruiser.mjs')
const LAYER_CONFIG = path.join(REPO_ROOT, '.dependency-cruiser.mjs')
const LAYER_BASELINE = path.join(REPO_ROOT, '.dependency-cruiser-known-violations.json')
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

  it('refuses a new import between two services the recorded baseline does not hold, and passes the one it holds', () => {
    const root = sampleTree({
      'scripts/bus/ladder-starter.ts': 'import { launch } from \'./launch-executor.js\'\nexport const ladder = launch\n',
      'scripts/bus/launch-executor.ts': 'export const launch = 1\n',
      'scripts/bus/merge-worker.ts': 'import { close } from \'./close-executor.js\'\nexport const merge = close\n',
      'scripts/bus/close-executor.ts': 'export const close = 1\n',
    })
    expect(depcruise(root, ['--config', LAYER_CONFIG, '--ignore-known', LAYER_BASELINE, 'scripts'])).toEqual({ status: 1, violations: ['bus-services-import-no-other-service scripts/bus/merge-worker.ts -> scripts/bus/close-executor.ts'] })
  }, CRUISE_TIMEOUT_MS)

  it('names every worker, executor and starter of the bus after its service, so the service rules see each one', () => {
    const serviceShaped = readdirSync(path.join(REPO_ROOT, 'scripts', 'bus')).filter(file => /(?:^|-)(?:worker|executor|starter)\.ts$/.test(file))
    expect(serviceShaped.filter(file => !/^[a-z]+-(?:worker|executor|starter)\.ts$/.test(file))).toEqual([])
    expect(serviceShaped).toContain('merge-executor.ts')
  })

  it('refuses a cycle inside the bus core', () => {
    const root = sampleTree({
      'scripts/bus/db.ts': 'import { reduce } from \'./reducer.js\'\nexport const db = () => reduce\n',
      'scripts/bus/reducer.ts': 'import { db } from \'./db.js\'\nexport const reduce = () => db\n',
    })
    expect(depcruise(root, ['--config', LAYER_CONFIG, 'scripts'])).toEqual({ status: 1, violations: ['no-circular-bus-core scripts/bus/db.ts -> scripts/bus/reducer.ts'] })
  }, CRUISE_TIMEOUT_MS)

  it('refuses an import from the product into the factory scripts', () => {
    const root = sampleTree({
      'src/cli.ts': 'import { bus } from \'../scripts/bus/db.js\'\nexport const cli = bus\n',
      'scripts/bus/db.ts': 'export const bus = 1\n',
    })
    expect(depcruise(root, ['--config', LAYER_CONFIG, 'src', 'scripts'])).toEqual({ status: 1, violations: ['src-imports-no-script src/cli.ts -> scripts/bus/db.ts'] })
  }, CRUISE_TIMEOUT_MS)

  it('lets the product import the core contour', () => {
    const root = sampleTree({
      'src/cli.ts': 'import { CARD_ADMITTED } from \'../scripts/core/events.js\'\nexport const cli = CARD_ADMITTED\n',
      'scripts/core/events.ts': 'export const CARD_ADMITTED = \'card.admitted\'\n',
    })
    expect(depcruise(root, ['--config', LAYER_CONFIG, 'src', 'scripts'])).toEqual({ status: 0, violations: [] })
  }, CRUISE_TIMEOUT_MS)

  it('refuses an import from the core contour into the bus, ghosts, shift or miko', () => {
    const root = sampleTree({
      'scripts/core/events.ts': ['bus/db', 'ghosts/journal', 'shift/shift', 'miko/loop'].map((module, index) => `import { a${index} } from '../${module}.js'`).join('\n'),
      'scripts/bus/db.ts': 'export const a0 = 1\n',
      'scripts/ghosts/journal.ts': 'export const a1 = 1\n',
      'scripts/shift/shift.ts': 'export const a2 = 1\n',
      'scripts/miko/loop.ts': 'export const a3 = 1\n',
    })
    expect(depcruise(root, ['--config', LAYER_CONFIG, 'scripts']).violations.sort()).toEqual([
      'core-imports-no-factory scripts/core/events.ts -> scripts/bus/db.ts',
      'core-imports-no-factory scripts/core/events.ts -> scripts/ghosts/journal.ts',
      'core-imports-no-factory scripts/core/events.ts -> scripts/miko/loop.ts',
      'core-imports-no-factory scripts/core/events.ts -> scripts/shift/shift.ts',
    ])
  }, CRUISE_TIMEOUT_MS)

  it('refuses an import from the bus into the ladder scripts outside ladder-starter', () => {
    const root = sampleTree({
      'scripts/bus/launch-worker.ts': 'import { journal } from \'../ghosts/journal.js\'\nexport const launch = journal\n',
      'scripts/ghosts/journal.ts': 'export const journal = 1\n',
    })
    expect(depcruise(root, ['--config', LAYER_CONFIG, 'scripts'])).toEqual({ status: 1, violations: ['bus-imports-no-ladder scripts/bus/launch-worker.ts -> scripts/ghosts/journal.ts'] })
  }, CRUISE_TIMEOUT_MS)

  it('lets ladder-starter import the ladder', () => {
    const root = sampleTree({
      'scripts/bus/ladder-starter.ts': 'import { supervise } from \'../ghosts/supervise.js\'\nexport const ladder = supervise\n',
      'scripts/ghosts/supervise.ts': 'export const supervise = 1\n',
    })
    expect(depcruise(root, ['--config', LAYER_CONFIG, 'scripts'])).toEqual({ status: 0, violations: [] })
  }, CRUISE_TIMEOUT_MS)

  it('refuses an import from the ports contour into the bus, ghosts, shift or miko', () => {
    const root = sampleTree({
      'scripts/ports/session.ts': ['bus/db', 'ghosts/journal', 'shift/shift', 'miko/loop'].map((module, index) => `import { a${index} } from '../${module}.js'`).join('\n'),
      'scripts/bus/db.ts': 'export const a0 = 1\n',
      'scripts/ghosts/journal.ts': 'export const a1 = 1\n',
      'scripts/shift/shift.ts': 'export const a2 = 1\n',
      'scripts/miko/loop.ts': 'export const a3 = 1\n',
    })
    expect(depcruise(root, ['--config', LAYER_CONFIG, 'scripts']).violations.sort()).toEqual([
      'ports-import-no-caller scripts/ports/session.ts -> scripts/bus/db.ts',
      'ports-import-no-caller scripts/ports/session.ts -> scripts/ghosts/journal.ts',
      'ports-import-no-caller scripts/ports/session.ts -> scripts/miko/loop.ts',
      'ports-import-no-caller scripts/ports/session.ts -> scripts/shift/shift.ts',
    ])
  }, CRUISE_TIMEOUT_MS)

  it('refuses an import from the bus into the intake command for an event name', () => {
    const root = sampleTree({
      'scripts/bus/card-automaton.ts': 'import { CARD_MOVED } from \'../../src/commands/intake/index.js\'\nexport const moved = CARD_MOVED\n',
      'src/commands/intake/index.ts': 'export const CARD_MOVED = \'card.moved\'\n',
    })
    expect(depcruise(root, ['--config', LAYER_CONFIG, 'scripts', 'src'])).toEqual({ status: 1, violations: ['bus-takes-event-names-from-core scripts/bus/card-automaton.ts -> src/commands/intake/index.ts'] })
  }, CRUISE_TIMEOUT_MS)
})

describe('the CI selector reads its layers from the one layer map', () => {
  it('the CI selector takes the layer of a file from the layer map', () => {
    const map = { files: { 'scripts/bus/queue.ts': 'core' }, folders: { 'scripts/bus/': 'bus', 'src/': 'src' } }
    expect(layerIn(map, 'scripts/bus/queue.ts')).toBe('core')
    expect(layerIn(map, 'scripts/bus/lease.ts')).toBe('bus')
    expect(layerIn(map, 'scripts/ghosts/launch.ts')).toBe('ghosts')
    expect(layerIn(map, 'docs/index.ts')).toBeNull()
    const recorded = readLayerMap()
    for (const [file, layer] of Object.entries(recorded.files))
      expect([file, layerOf(file)]).toEqual([file, layer])
  })

  it('a file two folders of the map claim belongs to no layer', () => {
    expect(layerIn({ files: {}, folders: { 'scripts/': 'scripts', 'scripts/bus/': 'bus' } }, 'scripts/bus/db.ts')).toBeNull()
  })
})

describe('a test that scans the scripts or src tree runs on every pull request', () => {
  it('a diff of only scripts/bus/board-page.ts selects scripts/tests/core/events.test.ts', () => {
    const run = selectRun(['scripts/bus/board-page.ts'], cruise(), test => readFileSync(path.join(REPO_ROOT, test), 'utf8'))
    expect(run.kind === 'layers' ? run.tests : run.why).toContain('scripts/tests/core/events.test.ts')
  }, CRUISE_TIMEOUT_MS)
})
