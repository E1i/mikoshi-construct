import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { layerIn, layerOf, selectRun } from '../../ci/layers.js'
import { cruise } from '../../ci/select.js'
import { readLayerMap } from '../../core/layer-map.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..')
const DEPCRUISE = path.join(REPO_ROOT, 'node_modules', 'dependency-cruiser', 'bin', 'dependency-cruiser.mjs')
const LAYER_CONFIG = path.join(REPO_ROOT, '.dependency-cruiser.mjs')
const LAYER_BASELINE = path.join(REPO_ROOT, '.dependency-cruiser-known-violations.json')
const LAYERS_CHECK = 'depcruise --config .dependency-cruiser.mjs --ignore-known .dependency-cruiser-known-violations.json scripts src'
const CRUISE_TIMEOUT_MS = 240_000
const NOTHING_TO_ITS_RIGHT = /^(.+)-imports-nothing-to-its-right$/

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

interface Cruise { status: number | null, violations: string[] }
interface Rule { name: string, from: { path: string | string[] }, to: { path: string | string[], pathNot?: string | string[] } }

const CONTOUR_SAMPLES = [
  { name: 'core', rank: 0, file: 'scripts/core/a.ts' },
  { name: 'ports', rank: 1, file: 'scripts/ports/a.ts' },
  { name: 'policy', rank: 2, file: 'scripts/policy/a.ts' },
  { name: 'nodes', rank: 3, file: 'scripts/nodes/x/a.ts' },
  { name: 'supervisor', rank: 4, file: 'scripts/supervisor/a.ts' },
  { name: 'window', rank: 4, file: 'scripts/window/a.ts' },
  { name: 'intake', rank: 4, file: 'scripts/intake/a.ts' },
  { name: 'cli', rank: 5, file: 'scripts/cli/a.ts' },
]

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

function specifier(from: string, to: string): string {
  const relative = path.posix.relative(path.posix.dirname(from), to).replace(/\.ts$/, '.js')
  return relative.startsWith('.') ? relative : `./${relative}`
}

function importing(edges: [from: string, ...to: string[]][]): Record<string, string> {
  const files: Record<string, string> = {}
  for (const [from, ...targets] of edges) {
    files[from] = `${targets.map(to => `import '${specifier(from, to)}'`).join('\n')}\nexport {}\n`
    for (const to of targets)
      files[to] ??= 'export {}\n'
  }
  return files
}

function violationsOf(edges: [from: string, ...to: string[]][], ...roots: string[]): Cruise {
  return depcruise(sampleTree(importing(edges)), ['--config', LAYER_CONFIG, ...roots])
}

function packageScripts(): Record<string, string> {
  return (JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts
}

async function configuredRules(): Promise<Rule[]> {
  const loaded = await import(pathToFileURL(LAYER_CONFIG).href) as { default: { forbidden: Rule[] } }
  return loaded.default.forbidden
}

function recordedViolations(): string[] {
  const recorded = JSON.parse(readFileSync(LAYER_BASELINE, 'utf8')) as { rule: { name: string }, from: string, to: string }[]
  return recorded.map(violation => `${violation.rule.name} ${violation.from} -> ${violation.to}`)
}

function nodeShapedFiles(): string[] {
  const found: string[] = []
  for (const entry of readdirSync(path.join(REPO_ROOT, 'scripts'), { recursive: true, withFileTypes: true })) {
    const relative = path.posix.join(path.relative(REPO_ROOT, entry.parentPath).split(path.sep).join('/'), entry.name)
    if (entry.isFile() && /(?:^|-)(?:worker|executor|starter)\.ts$/.test(entry.name) && !relative.startsWith('scripts/tests/'))
      found.push(relative)
  }
  return found.sort()
}

describe('the layer rules of the contours hold over scripts and src', () => {
  it('runs the layer check against the recorded baseline in the harness', () => {
    expect(packageScripts()['layers:check']).toBe(LAYERS_CHECK)
  })

  it('finds no layer violation in this repository beyond the recorded baseline', () => {
    expect(depcruise(REPO_ROOT, LAYERS_CHECK.split(' ').slice(1))).toEqual({ status: 0, violations: [] })
  }, CRUISE_TIMEOUT_MS)

  it('every contour has its rule and no import runs right', async () => {
    const ruled = (await configuredRules()).map(rule => NOTHING_TO_ITS_RIGHT.exec(rule.name)?.[1]).filter(name => name !== undefined).sort()
    expect(ruled).toEqual(CONTOUR_SAMPLES.filter(contour => CONTOUR_SAMPLES.some(other => other.rank > contour.rank)).map(contour => contour.name).sort())
    const expected = CONTOUR_SAMPLES.flatMap(from => CONTOUR_SAMPLES.filter(to => to.rank > from.rank).map(to => `${from.name}-imports-nothing-to-its-right ${from.file} -> ${to.file}`)).sort()
    const result = violationsOf(CONTOUR_SAMPLES.map(from => [from.file, ...CONTOUR_SAMPLES.filter(to => to !== from).map(to => to.file)]), 'scripts')
    expect(result.violations.sort()).toEqual(expected)
  }, CRUISE_TIMEOUT_MS)

  it('the code of each node lives in one folder nodes/<name>/', () => {
    const files = nodeShapedFiles()
    const elsewhere = files.filter(file => !/^scripts\/nodes\/([a-z]+)\/\1-(?:worker|executor|starter)\.ts$/.test(file))
    expect(elsewhere).toEqual(['scripts/ladder/ladder-starter.ts'])
    const folders = readdirSync(path.join(REPO_ROOT, 'scripts', 'nodes'), { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
    expect(folders).toEqual([...new Set(files.filter(file => file.startsWith('scripts/nodes/')).map(file => file.split('/')[2]!))].sort())
    expect(files).toContain('scripts/nodes/merge/merge-executor.ts')
  })

  it('the recorded baseline holds exactly the violations the rules find', () => {
    const found = depcruise(REPO_ROOT, ['--config', LAYER_CONFIG, 'scripts', 'src']).violations
    const recorded = recordedViolations()
    expect(recorded.filter(violation => !found.includes(violation))).toEqual([])
    expect(found.filter(violation => !recorded.includes(violation))).toEqual([])
  }, CRUISE_TIMEOUT_MS)

  it('refuses an import from the bus core into a service module', () => {
    const result = violationsOf([
      ['scripts/core/db.ts', 'scripts/nodes/review/review-worker.ts', 'scripts/ladder/ladder-starter.ts'],
    ], 'scripts')
    expect(result.violations.sort()).toEqual([
      'bus-core-imports-no-service scripts/core/db.ts -> scripts/ladder/ladder-starter.ts',
      'bus-core-imports-no-service scripts/core/db.ts -> scripts/nodes/review/review-worker.ts',
      'core-imports-nothing-to-its-right scripts/core/db.ts -> scripts/nodes/review/review-worker.ts',
      'no-factory-contour-imports-ladder scripts/core/db.ts -> scripts/ladder/ladder-starter.ts',
    ])
  }, CRUISE_TIMEOUT_MS)

  it('refuses an import from one node into another, and lets a node import its own executor', () => {
    expect(violationsOf([
      ['scripts/nodes/merge/merge-worker.ts', 'scripts/nodes/review/review-executor.ts', 'scripts/nodes/merge/merge-executor.ts'],
    ], 'scripts')).toEqual({ status: 1, violations: ['nodes-import-no-other-node scripts/nodes/merge/merge-worker.ts -> scripts/nodes/review/review-executor.ts'] })
  }, CRUISE_TIMEOUT_MS)

  it('refuses a new import between two nodes the recorded baseline does not hold, and passes the one it holds', () => {
    const root = sampleTree(importing([
      ['scripts/ladder/ladder-starter.ts', 'scripts/nodes/launch/launch-executor.ts'],
      ['scripts/nodes/merge/merge-worker.ts', 'scripts/nodes/close/close-executor.ts'],
    ]))
    expect(depcruise(root, ['--config', LAYER_CONFIG, '--ignore-known', LAYER_BASELINE, 'scripts'])).toEqual({ status: 1, violations: ['nodes-import-no-other-node scripts/nodes/merge/merge-worker.ts -> scripts/nodes/close/close-executor.ts'] })
  }, CRUISE_TIMEOUT_MS)

  it('refuses a cycle inside the bus core', () => {
    const root = sampleTree({
      'scripts/core/db.ts': 'import { reduce } from \'./reducer.js\'\nexport const db = () => reduce\n',
      'scripts/core/reducer.ts': 'import { db } from \'./db.js\'\nexport const reduce = () => db\n',
    })
    expect(depcruise(root, ['--config', LAYER_CONFIG, 'scripts'])).toEqual({ status: 1, violations: ['no-circular-bus-core scripts/core/db.ts -> scripts/core/reducer.ts'] })
  }, CRUISE_TIMEOUT_MS)

  it('refuses an import from the product into a core file outside the named ones', () => {
    expect(violationsOf([['src/cli.ts', 'scripts/core/db.ts']], 'src', 'scripts')).toEqual({ status: 1, violations: ['src-imports-no-script src/cli.ts -> scripts/core/db.ts'] })
  }, CRUISE_TIMEOUT_MS)

  it('refuses an import from the product into a contour other than core', () => {
    expect(violationsOf([['src/cli.ts', 'scripts/ports/gh.ts']], 'src', 'scripts')).toEqual({ status: 1, violations: ['src-imports-no-script src/cli.ts -> scripts/ports/gh.ts'] })
  }, CRUISE_TIMEOUT_MS)

  it('lets the product import the named core files and the owner channel', () => {
    expect(violationsOf([['src/cli.ts', 'scripts/core/events.ts', 'scripts/core/factory-paths.ts', 'scripts/owner/channel.ts']], 'src', 'scripts')).toEqual({ status: 0, violations: [] })
  }, CRUISE_TIMEOUT_MS)

  it('refuses an import from the core contour into the owner scripts or the commands', () => {
    const result = violationsOf([['scripts/core/events.ts', 'scripts/owner/channel.ts', 'src/commands/doctor/index.ts']], 'scripts', 'src')
    expect(result.violations.sort()).toEqual([
      'core-imports-no-factory scripts/core/events.ts -> scripts/owner/channel.ts',
      'core-imports-no-factory scripts/core/events.ts -> src/commands/doctor/index.ts',
    ])
  }, CRUISE_TIMEOUT_MS)

  it('refuses an import from the ladder into a contour other than core and ports', () => {
    const result = violationsOf([
      ['scripts/ladder/ladder.ts', 'scripts/core/a.ts', 'scripts/ports/a.ts', 'scripts/policy/a.ts', 'scripts/nodes/x/a.ts', 'scripts/window/a.ts', 'scripts/cli/a.ts'],
      ['scripts/done/check.ts', 'scripts/supervisor/a.ts', 'scripts/intake/a.ts'],
    ], 'scripts')
    expect(result.violations.sort()).toEqual([
      'ladder-imports-only-core-and-ports scripts/done/check.ts -> scripts/intake/a.ts',
      'ladder-imports-only-core-and-ports scripts/done/check.ts -> scripts/supervisor/a.ts',
      'ladder-imports-only-core-and-ports scripts/ladder/ladder.ts -> scripts/cli/a.ts',
      'ladder-imports-only-core-and-ports scripts/ladder/ladder.ts -> scripts/nodes/x/a.ts',
      'ladder-imports-only-core-and-ports scripts/ladder/ladder.ts -> scripts/policy/a.ts',
      'ladder-imports-only-core-and-ports scripts/ladder/ladder.ts -> scripts/window/a.ts',
    ])
  }, CRUISE_TIMEOUT_MS)

  it('refuses an import of the ladder from every factory contour, and lets the cli import it', () => {
    const importers = CONTOUR_SAMPLES.filter(contour => contour.name !== 'cli')
    const result = violationsOf([
      ...importers.map((contour): [string, string] => [contour.file, 'scripts/ladder/ladder.ts']),
      ['scripts/cli/a.ts', 'scripts/ladder/ladder.ts', 'scripts/done/check.ts'],
    ], 'scripts')
    expect(result.violations.filter(violation => violation.startsWith('no-factory-contour-imports-ladder')).sort()).toEqual(
      importers.map(contour => `no-factory-contour-imports-ladder ${contour.file} -> scripts/ladder/ladder.ts`).sort(),
    )
    expect(result.violations.filter(violation => violation.includes('scripts/cli/a.ts'))).toEqual([])
  }, CRUISE_TIMEOUT_MS)

  it('places the src folders of the intake and the cli contours at their ranks', () => {
    const result = violationsOf([
      ['src/card/risk.ts', 'scripts/cli/a.ts'],
      ['src/commands/board/index.ts', 'scripts/intake/a.ts'],
      ['src/commands/cost/index.ts', 'scripts/policy/a.ts'],
      ['scripts/morse/cli.ts', 'scripts/ladder/ladder.ts', 'scripts/nodes/x/a.ts'],
    ], 'scripts', 'src')
    expect(result.violations.filter(violation => violation.includes('-imports-nothing-to-its-right ')).sort()).toEqual([
      'intake-imports-nothing-to-its-right src/card/risk.ts -> scripts/cli/a.ts',
    ])
  }, CRUISE_TIMEOUT_MS)

  it('refuses an import from the factory contours into the intake command for an event name', () => {
    expect(violationsOf([['scripts/intake/a.ts', 'src/commands/intake/index.ts']], 'scripts', 'src')).toEqual({ status: 1, violations: ['takes-event-names-from-core scripts/intake/a.ts -> src/commands/intake/index.ts'] })
  }, CRUISE_TIMEOUT_MS)
})

describe('the CI selector reads its layers from the one layer map', () => {
  it('the CI selector takes the layer of a file from the layer map', () => {
    const map = { files: { 'scripts/core/queue.ts': 'queue' }, folders: { 'scripts/core/': 'core', 'src/': 'src' } }
    expect(layerIn(map, 'scripts/core/queue.ts')).toBe('queue')
    expect(layerIn(map, 'scripts/core/lease.ts')).toBe('core')
    expect(layerIn(map, 'scripts/ladder/launch.ts')).toBe('ladder')
    expect(layerIn(map, 'docs/index.ts')).toBeNull()
    const recorded = readLayerMap()
    for (const [file, layer] of Object.entries(recorded.files))
      expect([file, layerOf(file)]).toEqual([file, layer])
  })

  it('a file two folders of the map claim belongs to no layer', () => {
    expect(layerIn({ files: {}, folders: { 'scripts/': 'scripts', 'scripts/core/': 'core' } }, 'scripts/core/db.ts')).toBeNull()
  })
})

describe('a test that scans the scripts or src tree runs on every pull request', () => {
  it('a diff of only scripts/cli/board-page.ts selects scripts/tests/core/events.test.ts', () => {
    const run = selectRun(['scripts/cli/board-page.ts'], cruise(), test => readFileSync(path.join(REPO_ROOT, test), 'utf8'))
    expect(run.kind === 'layers' ? run.tests : run.why).toContain('scripts/tests/core/events.test.ts')
  }, CRUISE_TIMEOUT_MS)
})
