import type { AcceptedConcepts, Factory } from '../../scripts/contract/factory.js'
import type { FactoryWithLaws } from '../../scripts/contract/factory/laws.js'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { afterAll, describe, expect, it } from 'vitest'
import { selectRun } from '../../scripts/ci/layers.js'
import { scansATree } from '../../scripts/ci/tree-scanners.js'
import { conceptsSection, generateFactory, renderFactory } from '../../scripts/contract/factory.js'
import { AXES, CONCEPTS } from '../../scripts/contract/factory/concepts.js'
import { lawsSection, withLaws } from '../../scripts/contract/factory/laws.js'
import { findSites, overlapsSection } from '../../scripts/contract/factory/overlaps.js'
import { parsedFiles } from '../../scripts/contract/factory/walk.js'
import { BUS_VERSION } from '../../scripts/core/bus-version.js'
import { SCANNED_TREES } from '../../src/card/covering-tests.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')
const RECORDED = path.join(REPO_ROOT, 'contract', 'factory.json')
const THIS_TEST = 'tests/contract/factory.test.ts'
const GENERATION_TIMEOUT = 180_000
const CODE_MODULE = /\.(?:ts|mts|mjs|js)$/
const LINE_NUMBER = /:\d+/
const SITE_LINE = /^(\S+):(\d+) (\S+) /
const GIT_OWNER = 'scripts/ports/git.ts'

const CONCEPT_IDS = [
  'process-table',
  'pid-liveness',
  'live-session',
  'layers',
  'owner-decisions',
  'handoff-status',
  'ci-reading',
  'generated-files',
  'owner-commands',
  'git',
  'bus-read',
  'window-requests',
  'answer-duties',
]

const SITES_OF_THE_RECONNAISSANCE: Record<string, readonly string[]> = {
  'pid-liveness': [
    'scripts/quality/lock.ts',
    'scripts/ladder/cleanup.ts',
    'scripts/scratch/run-root.ts',
    'scripts/supervisor/bg.ts',
  ],
  'live-session': ['scripts/core/machine-sessions.ts'],
  'owner-decisions': [
    'scripts/nodes/launch/launch-candidates.ts',
    'scripts/core/inbox.ts',
    'scripts/core/reducer.ts',
    'scripts/nodes/answer/answer-source.ts',
    'scripts/core/bus-path.ts',
  ],
  'handoff-status': ['src/commands/doctor/factory.ts'],
  'owner-commands': [
    'scripts/window/window-requests.ts',
    'scripts/window/loop.ts',
    'scripts/window/compact-start.ts',
    'scripts/window/exit.ts',
  ],
}

let generatedFactory: FactoryWithLaws | undefined

function generated(): FactoryWithLaws {
  generatedFactory ??= withLaws(generateFactory())
  return generatedFactory
}

const scratchRoots: string[] = []

function fixtureTree(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'factory-fixture-'))
  scratchRoots.push(root)
  mkdirSync(path.join(root, 'scripts'))
  mkdirSync(path.join(root, 'src'))
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    writeFileSync(path.join(root, file), text)
  }
  return root
}

afterAll(() => {
  scratchRoots.forEach(root => rmSync(root, { recursive: true, force: true }))
})

function modulesUnderPorts(): string[] {
  const ports = path.join(REPO_ROOT, 'scripts', 'ports')
  return readdirSync(ports, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && CODE_MODULE.test(entry.name))
    .map(entry => path.relative(REPO_ROOT, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
    .sort()
}

function printedSites(): string[] {
  const script = path.join(REPO_ROOT, 'scripts', 'contract', 'overlaps.ts')
  return execFileSync(process.execPath, ['--import', 'tsx', script], { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim().split('\n')
}

describe('contract/factory.json', () => {
  it('contract/factory.json matches the generated file byte for byte; the test compares and never writes', () => {
    expect(renderFactory(generated()), 'contract/factory.json is stale: run `pnpm contract:update` and put its diff in the pull request').toBe(readFileSync(RECORDED, 'utf8'))
  }, GENERATION_TIMEOUT)

  it('contract/factory.json carries the laws registry scripts/nodes/laws.ts declares', () => {
    const { laws } = JSON.parse(readFileSync(RECORDED, 'utf8')) as FactoryWithLaws

    expect(laws).toEqual(JSON.parse(JSON.stringify(lawsSection())))
    expect(new Set(Object.keys(laws.laws))).toEqual(new Set(['Z1', 'Z2', 'Z3', 'Z4', 'Z5', 'Z6', 'Z7', 'Z8', 'Z9', 'Z10']))
    expect(laws.lawsVersion).toBeGreaterThan(0)
  })

  it('every module under scripts/ports has its exported functions and types with signatures', () => {
    const { ports: { modules: ports } } = generated()

    expect(Object.keys(ports)).toEqual(modulesUnderPorts())
    for (const [file, module] of Object.entries(ports))
      expect(Object.keys(module.functions).length + Object.keys(module.types).length + module.constants.length + module.reexports.length, `${file} records no export`).toBeGreaterThan(0)
    expect(ports['scripts/ports/git.ts']!.functions.parseWorktrees).toBe('(porcelain: string): WorktreeEntry[]')
    expect(ports['scripts/ports/git.ts']!.types.WorktreeEntry).toContain('branch: string | undefined')
  }, GENERATION_TIMEOUT)

  it('the bus section holds event types, payload keys, tables, columns and BUS_VERSION', () => {
    const { bus } = generated()

    expect(bus.busVersion).toBe(BUS_VERSION)
    expect(bus.events['session.heartbeat']!.keys).toEqual(expect.arrayContaining(['session', 'step']))
    expect(Object.keys(bus.events)).toEqual(expect.arrayContaining(['card.admitted', 'merge.done', 'task.completed', 'window.request']))
    expect(bus.tables.events).toEqual(expect.arrayContaining(['id', 'type', 'payload', 'dedupe_key']))
    expect(bus.tables.cards!.length).toBeGreaterThan(0)
  }, GENERATION_TIMEOUT)

  it('every concept of the order names one owner module and one of the five axes', () => {
    const { concepts } = generated()

    expect(Object.keys(concepts).sort()).toEqual([...CONCEPT_IDS].sort())
    for (const [id, concept] of Object.entries(concepts)) {
      expect(AXES, id).toContain(concept.axis)
      expect(existsSync(path.join(REPO_ROOT, concept.owner)), `${id}: ownerExists is ${concept.ownerExists} for ${concept.owner}`).toBe(concept.ownerExists)
      expect(concept.ownerExport === null, `${id}: ownerExport ${concept.ownerExport}`).toBe(!concept.ownerExists)
    }
  }, GENERATION_TIMEOUT)

  it('a concept the accepted model does not name reads proposed', () => {
    const concepts = conceptsSection({ git: { owner: GIT_OWNER, decision: 'D-335' } })

    expect(concepts.layers!.status).toBe('proposed')
    expect(Object.values(conceptsSection({})).map(concept => concept.status)).toEqual(CONCEPT_IDS.map(() => 'proposed'))
  })

  it('a concept the accepted model names with its owner reads accepted', () => {
    const concepts = conceptsSection({ git: { owner: GIT_OWNER, decision: 'D-335' } })

    expect(concepts.git!.status).toBe('accepted')
    expect(Object.keys(concepts).filter(id => concepts[id]!.status === 'accepted')).toEqual(['git'])
  })

  it('an accepted entry with another owner reads proposed', () => {
    expect(conceptsSection({ git: { owner: 'scripts/ports/moved-git.ts', decision: 'D-335' } }).git!.status).toBe('proposed')
  })

  it('an entry that cites no decision reads proposed, whatever its owner', () => {
    const entries = [
      GIT_OWNER,
      { owner: GIT_OWNER },
      { owner: GIT_OWNER, decision: '' },
      { owner: GIT_OWNER, decision: 'the owner said so' },
      { owner: GIT_OWNER, decision: 'xD-335' },
      { owner: GIT_OWNER, decision: 'D-335 and more' },
    ]

    for (const git of entries)
      expect(conceptsSection({ git } as unknown as AcceptedConcepts).git!.status, JSON.stringify(git)).toBe('proposed')
  })

  it('the status is derived at generation and CONCEPTS carries none by hand', () => {
    const accepted = JSON.parse(readFileSync(path.join(REPO_ROOT, 'contract', 'accepted.json'), 'utf8')) as { concepts: AcceptedConcepts }

    expect(generated().concepts).toEqual(conceptsSection(accepted.concepts))
    for (const concept of CONCEPTS)
      expect(concept, concept.id).not.toHaveProperty('status')
  }, GENERATION_TIMEOUT)

  it('overlaps lists a site for each duplicate A to F of the reconnaissance', () => {
    const { overlaps } = generated()

    for (const [concept, files] of Object.entries(SITES_OF_THE_RECONNAISSANCE))
      expect(Object.keys(overlaps[concept]!), concept).toEqual(expect.arrayContaining([...files]))
    expect(overlaps['process-table']).toEqual({})
    expect(overlaps['window-requests']).toEqual({})
    expect(overlaps.layers).toEqual({})
  }, GENERATION_TIMEOUT)

  it('a change to any scripts module selects the freshness test in the per-layer CI run', () => {
    const text = readFileSync(path.join(REPO_ROOT, THIS_TEST), 'utf8')
    const modules = parsedFiles(REPO_ROOT, ['scripts']).map(({ file }) => file)
    const graph = new Map<string, readonly string[]>([...modules.map(file => [file, []] as const), [THIS_TEST, []]])

    expect(scansATree(text)).toBe(true)
    expect(modules.length).toBeGreaterThan(100)
    for (const module of modules) {
      const run = selectRun([module], graph, () => text)

      expect(run.kind === 'full' || run.tests.includes(THIS_TEST), module).toBe(true)
    }
    expect(SCANNED_TREES['scripts/']).toContain(THIS_TEST)
    expect(SCANNED_TREES['src/']).toContain(THIS_TEST)
    const unlistedTest = 'tests/contract/unlisted.test.ts'
    const unlistedGraph = new Map<string, readonly string[]>([['scripts/ports/git.ts', []], [unlistedTest, []]])
    const scanning = selectRun(['scripts/ports/git.ts'], unlistedGraph, () => text)
    const notScanning = selectRun(['scripts/ports/git.ts'], unlistedGraph, () => '')

    expect(scanning.kind === 'layers' && scanning.tests).toEqual([unlistedTest])
    expect(notScanning.kind === 'layers' && notScanning.tests).toEqual([])
  }, GENERATION_TIMEOUT)

  it('a duplicate seeded outside its owner in a fixture tree is reported with file and line, and a mention in a comment is not', () => {
    const root = fixtureTree({
      'scripts/seeded/process.ts': `import { execFileSync } from 'node:child_process'\n\nexport const table = execFileSync('ps', ['-A'])\n`,
      'scripts/seeded/mention.ts': `// execFileSync('ps', ['-A']) and process.kill(pid, 0)\nexport const words = "execFileSync('ps')"\n`,
      'scripts/tests/seeded.test.ts': `import { execFileSync } from 'node:child_process'\n\nexport const table = execFileSync('ps', ['-A'])\n`,
      'scripts/tests/helper.ts': `import { execFileSync } from 'node:child_process'\n\nexport const table = execFileSync('ps', ['-A'])\n`,
      'scripts/ports/process-table.ts': `import { execFileSync } from 'node:child_process'\n\nexport const table = execFileSync('ps', ['-A'])\n`,
    })

    const sites = findSites(root)

    expect(sites).toEqual([{ concept: 'process-table', file: 'scripts/seeded/process.ts', line: 3, form: `execFileSync('ps')` }])
    expect(overlapsSection(sites)['process-table']).toEqual({ 'scripts/seeded/process.ts': 1 })
  })

  it('reads the client process name from the adapter, so the literal stays in the adapter', () => {
    const concepts = readFileSync(path.join(REPO_ROOT, 'scripts', 'contract', 'factory', 'concepts.ts'), 'utf8')

    expect(concepts).toContain('clientAdapter().processes')
    expect(CONCEPTS.find(concept => concept.id === 'live-session')!.detectors.length).toBeGreaterThan(0)
  })

  it('the committed overlaps hold each file with a count and no line number, and contract:overlaps prints as many file:line sites as that count', () => {
    const committed = JSON.parse(readFileSync(RECORDED, 'utf8')) as Factory
    const printed = printedSites().map(line => SITE_LINE.exec(line))
    const counted: Record<string, Record<string, number>> = Object.fromEntries(Object.keys(committed.overlaps).map(concept => [concept, {}]))

    for (const match of printed) {
      expect(match).not.toBeNull()
      const [, file, , concept] = match!
      counted[concept!]![file!] = (counted[concept!]![file!] ?? 0) + 1
    }

    expect(LINE_NUMBER.test(JSON.stringify(Object.values(committed.overlaps).flatMap(files => Object.keys(files))))).toBe(false)
    for (const files of Object.values(committed.overlaps)) {
      for (const count of Object.values(files))
        expect(Number.isInteger(count) && count > 0).toBe(true)
    }
    expect(counted).toEqual(committed.overlaps)
  }, GENERATION_TIMEOUT)
})
