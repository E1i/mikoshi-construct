import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { CONCEPTS, GIT_BEYOND_THE_PORT } from '../../contract/factory/concepts.js'
import { programCall } from '../../contract/factory/detectors.js'
import { findSites, overlapsSection } from '../../contract/factory/overlaps.js'
import { parsedFiles } from '../../contract/factory/walk.js'
import { runNode, SWITCH_FLAG } from '../../core/node.js'
import { runAnswerWorker } from '../../nodes/answer/answer-worker.js'
import { runCloseWorker } from '../../nodes/close/close-worker.js'
import { runLaunchWorker } from '../../nodes/launch/launch-root.js'
import { runMergeWorker } from '../../nodes/merge/merge-worker.js'
import { runReview } from '../../nodes/review/review-worker.js'
import { runUpdateWorker } from '../../nodes/update/update-worker.js'
import { runWitnessWorker } from '../../nodes/witness/witness-worker.js'
import { loadedCodeSha, processGit, readThroughPort } from '../../ports/git.js'

vi.mock('../../core/node.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../core/node.js')>()
  return { ...real, runNode: vi.fn(async () => 0) }
})

const REPO = path.resolve(import.meta.dirname, '..', '..', '..')
const CORE = 'scripts/core/'
const CHILD_PROCESS = /from\s+'node:child_process'|require\(\s*'node:child_process'\s*\)|import\(\s*'node:child_process'\s*\)/
const GIT_ANYWHERE = CONCEPTS.filter(concept => concept.id === 'git').map(concept => ({ ...concept, detectors: [programCall(['git'])] }))

const roots: string[] = []
const PORTS_DIR = path.join(REPO, 'scripts', 'ports')
const SHA = 'a'.repeat(40)

afterEach(() => {
  vi.restoreAllMocks()
  vi.mocked(runNode).mockClear()
})

afterAll(() => {
  roots.forEach(root => rmSync(root, { recursive: true, force: true }))
})

function treeWith(planted: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'core-runs-no-git-'))
  roots.push(root)
  mkdirSync(path.join(root, 'src'))
  mkdirSync(path.join(root, CORE), { recursive: true })
  for (const [file, text] of Object.entries(planted))
    writeFileSync(path.join(root, file), text)
  return root
}

function coreFilesRunningGit(root: string): string[] {
  return Object.keys(overlapsSection(findSites(root, GIT_ANYWHERE), GIT_ANYWHERE).git ?? {}).filter(file => file.startsWith(CORE)).sort()
}

describe('core runs no git', () => {
  it('no file under scripts/core runs git or imports child_process', () => {
    expect(parsedFiles(REPO, [CORE]).filter(({ source }) => CHILD_PROCESS.test(source.text)).map(({ file }) => file)).toEqual([])
    expect(coreFilesRunningGit(REPO)).toEqual([])
  })

  it('a git call planted in core is found, so the check above can fail', () => {
    const planted = 'import { execFileSync } from \'node:child_process\'\nexport const sha = execFileSync(\'git\', [\'rev-parse\', \'HEAD\'])'
    const root = treeWith({ 'scripts/core/planted.ts': planted })

    expect(coreFilesRunningGit(root)).toEqual(['scripts/core/planted.ts'])
    expect(parsedFiles(root, [CORE]).filter(({ source }) => CHILD_PROCESS.test(source.text)).map(({ file }) => file)).toEqual(['scripts/core/planted.ts'])
  })

  it('no file under scripts/core stands beyond the git port', () => {
    expect([...GIT_BEYOND_THE_PORT].filter(file => file.startsWith(CORE))).toEqual([])
  })
})

const COMPOSITIONS: Record<string, (argv: string[]) => Promise<number>> = {
  answer: async argv => runAnswerWorker(argv, { busPath: 'bus.db', pause: async () => {} } as never),
  close: async argv => runCloseWorker(argv, { busPath: 'bus.db', pause: async () => {} } as never),
  launch: async argv => runLaunchWorker(argv, { busPath: 'bus.db', pause: async () => {} } as never),
  merge: async argv => runMergeWorker(argv, { busPath: 'bus.db', pause: async () => {} } as never),
  review: async argv => runReview(argv, { busPath: 'bus.db', pause: async () => {} } as never),
  update: async argv => runUpdateWorker(argv, { busPath: 'bus.db', pause: async () => {} } as never),
  witness: async argv => runWitnessWorker(argv, { busPath: 'bus.db', pause: async () => {}, repo: REPO } as never),
}

describe('every node composition hands core the code sha the git port reads', () => {
  for (const [kind, compose] of Object.entries(COMPOSITIONS)) {
    it(`${kind} hands runNode the port's loadedCodeSha`, async () => {
      await compose([SWITCH_FLAG])

      expect(runNode).toHaveBeenCalledTimes(1)
      const [, calledKind, , , ctx] = vi.mocked(runNode).mock.calls[0]!
      expect(calledKind).toBe(kind)
      expect(ctx.codeSha).toBe(loadedCodeSha)
    })
  }
})

describe('the git port reads what core used to read itself', () => {
  it('loadedCodeSha reads HEAD from the directory of the code and trims the line', () => {
    const read = vi.spyOn(processGit, 'readOrNull').mockReturnValue(`${SHA}\n`)

    expect(loadedCodeSha()).toBe(SHA)
    expect(read).toHaveBeenCalledWith(PORTS_DIR, ['rev-parse', 'HEAD'])
  })

  it('loadedCodeSha is null when git cannot read HEAD', () => {
    vi.spyOn(processGit, 'readOrNull').mockReturnValue(null)

    expect(loadedCodeSha()).toBeNull()
  })

  it('loadedCodeSha in this checkout is the sha of its HEAD', () => {
    expect(loadedCodeSha()).toBe(processGit.read(REPO, ['rev-parse', 'HEAD']).trim())
  })

  it('readThroughPort hands the tree and the arguments to the port and returns what it read', () => {
    const read = vi.spyOn(processGit, 'read').mockReturnValue('/repo/.git\n')

    expect(readThroughPort('/repo/tree', ['rev-parse', '--git-common-dir'])).toBe('/repo/.git\n')
    expect(read).toHaveBeenCalledWith('/repo/tree', ['rev-parse', '--git-common-dir'])
  })
})
