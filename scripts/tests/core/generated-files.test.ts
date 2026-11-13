import type { DatabaseSync as Database } from 'node:sqlite'
import type { ShiftTask } from '../../../src/card/task-file.js'
import type { Graph } from '../../ci/layers.js'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { isTest, selectRun } from '../../ci/layers.js'
import { cruise } from '../../ci/select.js'
import { catalogDocumentReads, catalogModules, catalogTests, overlapWithMain, writeCatalog } from '../../cli/check-catalog.js'
import { CONCEPTS } from '../../contract/factory/concepts.js'
import { findSites } from '../../contract/factory/overlaps.js'
import { RATCHET_RECORD } from '../../contract/ratchet.js'
import { GENERATED_FILES as REEXPORTED } from '../../core/factory-paths.js'
import { APPEND_ONLY_LOGS, commandLine, GENERATED_FILES, GENERATED_PATHS, isRebuiltOnUpdate, pathsRebuiltBy, RATCHET_FILE, rebuildsOf, REBUILT_ON_UPDATE, SHARED_APPEND_PATHS } from '../../core/generated-files.js'
import { readLayerMap, recordsOf } from '../../core/layer-map.js'
import { taskConflicts } from '../../nodes/launch/overlap.js'
import { sharedAppendFiles } from '../../nodes/launch/shared-files.js'
import { mainMergeInCardTree } from '../../ports/main-merge.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..')
const OWNER = 'scripts/core/generated-files.ts'
const SLOW = 300_000
const FACTORY = GENERATED_FILES.factory.path
const OWN = 'scripts/own.ts'
const OUTSIDE = '.changeset/shared.md'
const REBUILT_TEXT = 'rebuilt\n'
const CONTRACT_LAYER_READER = 'tests/contract/ratchet.test.ts'
const NEEDS_UPDATE = 'main changed the layer contract since the base'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function temporaryRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'generated-files-'))
  roots.push(root)
  return root
}

function write(tree: string, file: string, text: string): void {
  mkdirSync(path.dirname(path.join(tree, file)), { recursive: true })
  writeFileSync(path.join(tree, file), text)
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, '-c', 'user.name=bus', '-c', 'user.email=bus@example.invalid', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

function commitAll(tree: string, message: string): string {
  git(tree, ['add', '-A'])
  git(tree, ['commit', '-q', '-m', message])
  return git(tree, ['rev-parse', 'HEAD'])
}

interface Moved { file: string, card: string, main: string }

function bench(moves: readonly Moved[]) {
  const root = temporaryRoot()
  const origin = path.join(root, 'origin.git')
  const seed = path.join(root, 'seed')
  const tree = path.join(root, 'tree')
  const branch = 'feat/card-1'
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin])
  execFileSync('git', ['clone', '-q', origin, seed], { stdio: 'ignore' })
  git(seed, ['checkout', '-q', '-b', 'main'])
  write(seed, OWN, 'base\n')
  for (const { file } of moves)
    write(seed, file, 'base\n')
  commitAll(seed, 'base')
  git(seed, ['push', '-q', 'origin', 'main'])
  execFileSync('git', ['clone', '-q', '-b', 'main', origin, tree], { stdio: 'ignore' })
  git(tree, ['checkout', '-q', '-b', branch])
  write(tree, OWN, 'card version\n')
  for (const { file, card } of moves)
    write(tree, file, card)
  const head = commitAll(tree, 'card work')
  git(tree, ['push', '-q', 'origin', branch])
  for (const { file, main } of moves)
    write(seed, file, main)
  write(seed, 'scripts/main-moved.ts', 'main\n')
  commitAll(seed, 'main moves')
  git(seed, ['push', '-q', 'origin', 'main'])
  return { tree, origin, branch, head, card: { cardId: 1, branch, head, outsideTheCard: (files: string[]) => files } }
}

function task(id: number, touches: string[]): ShiftTask {
  return { id, file: `${id}.md`, branch: `feat/${id}`, touches, body: '' } as unknown as ShiftTask
}

interface Catalog { db: Database, graph: Graph, text: (test: string) => string }

const catalog = ((): (() => Catalog) => {
  let built: Catalog | undefined
  return () => {
    if (built === undefined) {
      const graph = cruise()
      const text = (test: string): string => readFileSync(path.join(REPO_ROOT, test), 'utf8')
      const tests = catalogTests({ graph, testText: text, cards: [], briefs: [], journal: '' })
      const db = new DatabaseSync(':memory:')
      writeCatalog(db, { tests, mutations: [], modules: catalogModules(graph), documentReads: catalogDocumentReads(graph, text) })
      built = { db, graph, text }
    }
    return built
  }
})()

describe('the one list of generated files', () => {
  const concepts = CONCEPTS.filter(concept => concept.id === 'generated-files')

  it('a generated path literal outside the owner is red', () => {
    const fixture = temporaryRoot()
    write(fixture, 'scripts/stray.ts', `export const stray = '${FACTORY}'\n`)
    write(fixture, OWNER, `export const owned = '${FACTORY}'\n`)
    write(fixture, 'src/clean.ts', 'export const clean = 1\n')
    expect(findSites(fixture, concepts).map(site => site.file)).toEqual(['scripts/stray.ts'])
    expect(findSites(REPO_ROOT, concepts)).toEqual([])
  }, SLOW)

  it('names its owner, and the ratified record agrees', () => {
    const accepted = JSON.parse(readFileSync(path.join(REPO_ROOT, 'contract/accepted.json'), 'utf8')) as { concepts: Record<string, { owner: string }> }
    expect(concepts[0]).toMatchObject({ owner: OWNER, ownerExists: true })
    expect(accepted.concepts['generated-files']!.owner).toBe(OWNER)
    expect(REEXPORTED).toBe(GENERATED_FILES)
  })

  it('keeps the ratchet record apart from the detector and under the name its own module gives it', () => {
    expect(RATCHET_FILE.path).toBe(RATCHET_RECORD)
    expect(GENERATED_PATHS).not.toContain(RATCHET_RECORD)
  })

  it('renders a rebuild as the command line a brief states', () => {
    expect(commandLine(GENERATED_FILES.surface.rebuild)).toBe('pnpm contract:update')
    expect(rebuildsOf([GENERATED_FILES.surface.path, FACTORY])).toEqual([GENERATED_FILES.factory.rebuild])
    expect(rebuildsOf([RATCHET_RECORD, GENERATED_FILES.earlierCarriers.path])).toEqual([GENERATED_FILES.earlierCarriers.rebuild, RATCHET_FILE.rebuild])
  })

  it('the rebuild of the factory contract writes the command surface as well, and nothing else', () => {
    expect(pathsRebuiltBy(GENERATED_FILES.factory.rebuild).sort()).toEqual([FACTORY, GENERATED_FILES.surface.path])
    expect(pathsRebuiltBy(RATCHET_FILE.rebuild)).toEqual([RATCHET_RECORD])
  })

  it('the manifest field sharedAppendFiles is the list the owner rebuilds on an update and the append-only logs', () => {
    expect(sharedAppendFiles(REPO_ROOT).sort()).toEqual([...SHARED_APPEND_PATHS].sort())
    expect(SHARED_APPEND_PATHS).toEqual([...REBUILT_ON_UPDATE.map(row => row.path), ...APPEND_ONLY_LOGS])
  })

  it('an append-only log is shared by cards and never rebuilt on an update', () => {
    for (const log of APPEND_ONLY_LOGS) {
      expect(isRebuiltOnUpdate(log)).toBe(false)
      expect(rebuildsOf([log])).toEqual([])
    }
    expect(isRebuiltOnUpdate(GENERATED_FILES.factory.path)).toBe(true)
  })

  it('two cards sharing only a generated file do not overlap', () => {
    const shared = sharedAppendFiles(REPO_ROOT)
    for (const file of shared) {
      expect(taskConflicts([task(1, [file, 'scripts/a.ts']), task(2, [file, 'scripts/b.ts'])], shared)).toEqual([])
      expect(taskConflicts([task(1, [file]), task(2, [file])])).toHaveLength(1)
    }
    expect(taskConflicts([task(1, ['scripts/a.ts']), task(2, ['scripts/a.ts'])], shared)).toHaveLength(1)
  })
})

describe('an update on a card that carries a generated file', () => {
  function rebuilding(file: string, calls: (readonly string[])[]) {
    return (cwd: string, args: readonly string[]) => {
      calls.push(args)
      write(cwd, file, REBUILT_TEXT)
      return { status: 0, stderr: '' }
    }
  }

  it('an update rebuilds the generated files on a rebase', () => {
    const { tree, origin, branch, head, card } = bench([{ file: FACTORY, card: 'card version\n', main: 'main version\n' }])
    const calls: (readonly string[])[] = []
    const outcome = mainMergeInCardTree(git, () => tree, rebuilding(FACTORY, calls))(card)
    const merged = git(tree, ['rev-parse', 'HEAD'])
    expect(outcome).toEqual({ kind: 'merged', to: merged, tookMain: [], rebuilt: [FACTORY] })
    expect(calls).toEqual([GENERATED_FILES.factory.rebuild])
    expect(readFileSync(path.join(tree, FACTORY), 'utf8')).toBe(REBUILT_TEXT)
    expect(git(tree, ['status', '--porcelain'])).toBe('')
    expect(git(tree, ['rev-list', '--parents', '-n', '1', merged]).split(' ')).toEqual([merged, head, git(tree, ['rev-parse', 'origin/main'])])
    expect(git(origin, ['rev-parse', `refs/heads/${branch}`])).toBe(merged)
  })

  it('rebuilds a generated file the card changed even when the merge is clean, and takes main on the rest', () => {
    const { tree, card } = bench([
      { file: GENERATED_FILES.surface.path, card: 'card\nbase\n', main: 'base\nmain\n' },
      { file: OUTSIDE, card: 'card version\n', main: 'main version\n' },
    ])
    const calls: (readonly string[])[] = []
    const outcome = mainMergeInCardTree(git, () => tree, rebuilding(GENERATED_FILES.surface.path, calls))(card)
    expect(outcome).toMatchObject({ kind: 'merged', tookMain: [OUTSIDE], rebuilt: [GENERATED_FILES.surface.path] })
    expect(calls).toEqual([GENERATED_FILES.surface.rebuild])
    expect(readFileSync(path.join(tree, OUTSIDE), 'utf8')).toBe('main version\n')
    expect(readFileSync(path.join(tree, GENERATED_FILES.surface.path), 'utf8')).toBe(REBUILT_TEXT)
  })

  it('runs no rebuild for a card that carries no generated file', () => {
    const { tree, card } = bench([{ file: OUTSIDE, card: 'card\n', main: 'main\n' }])
    const calls: (readonly string[])[] = []
    expect(mainMergeInCardTree(git, () => tree, rebuilding(FACTORY, calls))(card)).toMatchObject({ kind: 'merged', rebuilt: [] })
    expect(calls).toEqual([])
  })

  it('a failed rebuild leaves the tree at the head and pushes nothing', () => {
    const { tree, origin, branch, head, card } = bench([{ file: FACTORY, card: 'card version\n', main: 'main version\n' }])
    const outcome = mainMergeInCardTree(git, () => tree, () => ({ status: 1, stderr: 'broken\n' }))(card)
    expect(outcome).toMatchObject({ kind: 'refused' })
    expect(outcome.kind === 'refused' && outcome.why).toContain('pnpm contract:update exited 1: broken')
    expect(git(tree, ['rev-parse', 'HEAD'])).toBe(head)
    expect(git(origin, ['rev-parse', `refs/heads/${branch}`])).toBe(head)
  })

  it('a generated file does not hide a conflict inside the card touches', () => {
    const { tree, head, card } = bench([
      { file: FACTORY, card: 'card version\n', main: 'main version\n' },
      { file: 'scripts/inside.ts', card: 'card version\n', main: 'main version\n' },
    ])
    const outcome = mainMergeInCardTree(git, () => tree, rebuilding(FACTORY, []))({ ...card, outsideTheCard: () => [] })
    expect(outcome).toEqual({ kind: 'inside', files: ['scripts/inside.ts'] })
    expect(git(tree, ['rev-parse', 'HEAD'])).toBe(head)
  })
})

describe('the layer of the contract records', () => {
  it('a pull request outside the contract layer needs no update when main changed only contract/ratchet.json', () => {
    const { db } = catalog()
    expect(overlapWithMain(db, ['scripts/window/loop.ts'], [RATCHET_RECORD])).toBeNull()
    expect(overlapWithMain(db, ['src/commands/doctor/factory.ts'], [RATCHET_RECORD])).toBeNull()
    expect(overlapWithMain(db, ['src/commands/doctor/factory.ts'], [RATCHET_RECORD], () => null, { card: { touches: ['src/commands/doctor/factory.ts'], runs: ['tests/contract/**'], masks: [] } })).toBeNull()
  }, SLOW)

  it('a change to contract/ratchet.json selects its readers, not the full run', () => {
    const { graph, text } = catalog()
    const run = selectRun([RATCHET_RECORD], graph, text)
    expect(run.kind).toBe('layers')
    const tests = run.kind === 'layers' ? run.tests : []
    expect(tests).toEqual(expect.arrayContaining([CONTRACT_LAYER_READER, 'tests/contract/factory.test.ts', 'scripts/tests/bus/ratchet-merge-policy.test.ts']))
    expect(tests).not.toContain('scripts/tests/bus/answer-ci-log.test.ts')
    const allTests = [...graph.keys()].filter(isTest)
    for (const record of recordsOf(readLayerMap())) {
      const recordRun = selectRun([record], graph, text)
      const readers = allTests.filter(test => text(test).includes(path.posix.basename(record)))
      expect(readers.length).toBeGreaterThan(0)
      expect(recordRun.kind === 'layers' ? recordRun.tests : []).toEqual(expect.arrayContaining(readers))
    }
  }, SLOW)

  it('a pull request that changes a contract record still updates when main changed one', () => {
    const { db } = catalog()
    expect(overlapWithMain(db, [FACTORY], [RATCHET_RECORD])).toBe(NEEDS_UPDATE)
    expect(overlapWithMain(db, [RATCHET_RECORD], [FACTORY])).toBe(NEEDS_UPDATE)
    expect(overlapWithMain(db, ['scripts/contract/update.ts'], [RATCHET_RECORD])).toBe(NEEDS_UPDATE)
    expect(overlapWithMain(db, ['scripts/core/queue.ts'], ['scripts/window/loop.ts'])).not.toBeNull()
  }, SLOW)
})
