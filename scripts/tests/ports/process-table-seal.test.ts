import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { CONCEPTS } from '../../contract/factory/concepts.js'
import { findSites, overlapsSection } from '../../contract/factory/overlaps.js'
import { knownLivenessSites, LIVENESS_JUDGE, livenessSources } from '../../supervisor/liveness-sites.js'

const REPO_ROOT = path.join(import.meta.dirname, '..', '..', '..')
const PORT = 'scripts/ports/process-table.ts'
const PLANTED_FILE = 'scripts/nodes/planted.ts'
const SCAN_TIMEOUT = 180_000
const LIVENESS_WORDS = /\balive\b|\bliveness\b|\bisAlive\b|process\.kill\(/i
const LIVENESS_JUDGEMENT = /\bkill\([^,()]+,\s*0\s*\)|\b(?:function|const|let)\s+(?:alive|isAlive|\w*Liveness)\b|import\s*\{[^}]*\b(?:alive|isAlive)\b[^}]*\}|\bprocess (?:alive|dead)\b/
const PORT_IMPORT = /from\s+['"][./]*(?:ports\/)?process-table\.js['"]/
const LEFT_FOR_THE_PORT = ['scripts/ladder/watch-process.ts', 'scripts/nodes/launch/launch-starter.ts', 'scripts/nodes/restart/chain-process.ts', 'scripts/supervisor/bg.ts', 'scripts/window/exit.ts', 'scripts/window/loop.ts']
const KNOWN_ENTRIES_AT_BASE = 18
const LOCAL_LOCK_JUDGEMENTS: readonly { file: string, judgement: RegExp }[] = [
  { file: 'scripts/supervisor/bg.ts', judgement: /export function alive\(pid: number\): boolean \{\s*try \{\s*process\.kill\(pid, 0\)\s*return true\s*\}/ },
  { file: 'scripts/nodes/answer/answerer.ts', judgement: /import \{ isAlive \} from '\.\.\/\.\.\/quality\/lock\.js'/ },
]
const PROCESS_CONCEPTS = CONCEPTS.filter(concept => concept.id === 'process-table' || concept.id === 'pid-liveness')

const PLANTED: readonly (readonly [string, string])[] = [
  ['a ps call', 'import { execFileSync } from \'node:child_process\'\nexport const rows = execFileSync(\'ps\', [\'-Ao\', \'pid=\'])'],
  ['an lsof call', 'import { execFileSync } from \'node:child_process\'\nexport const cwd = execFileSync(\'lsof\', [\'-p\', \'1\'])'],
  ['a kill zero', 'export function probe(pid: number) { process.kill(pid, 0) }'],
]

const roots: string[] = []

afterAll(() => {
  roots.forEach(root => rmSync(root, { recursive: true, force: true }))
})

function treeWith(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'process-seal-'))
  roots.push(root)
  mkdirSync(path.join(root, 'src'))
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    writeFileSync(path.join(root, file), text)
  }
  return root
}

function filesWithSites(root: string): string[] {
  const section = overlapsSection(findSites(root, PROCESS_CONCEPTS), PROCESS_CONCEPTS)
  return [...new Set(Object.values(section).flatMap(perFile => Object.keys(perFile)))].sort()
}

function recordedInTheKnownList(): Set<string> {
  return new Set(knownLivenessSites(REPO_ROOT).map(site => site.file))
}

function withoutLocalLockJudgement(file: string, text: string, kept: typeof LOCAL_LOCK_JUDGEMENTS): string {
  return kept.filter(each => each.file === file).reduce((rest, each) => rest.replace(each.judgement, ''), text)
}

function judgesByThePort(sources: ReadonlyMap<string, string>, kept: typeof LOCAL_LOCK_JUDGEMENTS): string[] {
  return [...sources].filter(([file, text]) => file !== PORT && file !== LIVENESS_JUDGE && PORT_IMPORT.test(text) && LIVENESS_JUDGEMENT.test(withoutLocalLockJudgement(file, text, kept))).map(([file]) => file).sort()
}

describe('the seal of the process table', () => {
  it('a ps, lsof or kill zero outside the port is red', { timeout: SCAN_TIMEOUT }, () => {
    for (const [label, line] of PLANTED)
      expect(filesWithSites(treeWith({ [PLANTED_FILE]: line })), label).toEqual([PLANTED_FILE])
    const excused = recordedInTheKnownList()
    expect(filesWithSites(REPO_ROOT).filter(file => !excused.has(file))).toEqual([])
  })

  it('the live session detector sees machine-sessions and watch-process', { timeout: SCAN_TIMEOUT }, () => {
    const liveSession = CONCEPTS.filter(concept => concept.id === 'live-session')
    const root = treeWith({
      'scripts/core/machine-sessions.ts': 'export function sessionLiveness() { return 1 }',
      'scripts/ladder/watch-process.ts': 'export function isSessionAlive() { return true }',
    })

    expect(Object.keys(overlapsSection(findSites(root, liveSession), liveSession)['live-session']!).sort()).toEqual(['scripts/core/machine-sessions.ts', 'scripts/ladder/watch-process.ts'])
  })

  it('the port answers facts only and has no alive', () => {
    const port = readFileSync(path.join(REPO_ROOT, PORT), 'utf8')

    expect(port).not.toMatch(LIVENESS_WORDS)
  })

  it('no caller judges liveness by the port', () => {
    const planted = new Map([
      ['scripts/nodes/judge.ts', 'import { OsProcessTable, rowOf } from \'../ports/process-table.js\'\nexport function alive(pid: number) { return rowOf(new OsProcessTable().snapshot(), pid) !== null }'],
      ['scripts/nodes/fact.ts', 'import { OsProcessTable, rowOf } from \'../ports/process-table.js\'\nexport function rowFor(pid: number) { return rowOf(new OsProcessTable().snapshot(), pid) }'],
    ])
    expect(judgesByThePort(planted, [])).toEqual(['scripts/nodes/judge.ts'])

    const sources = livenessSources(REPO_ROOT)
    const listedCaller = 'scripts/window/exit.ts'
    const judgingListedCaller = new Map([[listedCaller, `${sources.get(listedCaller)}\nexport function alive(pid: number) { return rowOf(new OsProcessTable().snapshot(), pid) !== null }\n`]])
    expect(recordedInTheKnownList().has(listedCaller)).toBe(true)
    expect(judgesByThePort(judgingListedCaller, LOCAL_LOCK_JUDGEMENTS)).toEqual([listedCaller])

    const lockByThePort = 'scripts/supervisor/bg.ts'
    const bgByThePort = new Map([[lockByThePort, sources.get(lockByThePort)!.replace('process.kill(pid, 0)', 'if (rowOf(new OsProcessTable().snapshot(), pid) === null) throw new Error()')]])
    expect(judgesByThePort(bgByThePort, LOCAL_LOCK_JUDGEMENTS)).toEqual([lockByThePort])

    for (const { file } of LOCAL_LOCK_JUDGEMENTS)
      expect(recordedInTheKnownList().has(file), file).toBe(true)
    expect(judgesByThePort(sources, LOCAL_LOCK_JUDGEMENTS)).toEqual([])
  })

  it('the known list takes the port only when more entries leave it', () => {
    const known = knownLivenessSites(REPO_ROOT)
    const processTableEntries = known.filter(site => site.kind === 'ps')

    expect(processTableEntries).toEqual([{ file: PORT, kind: 'ps' }])
    expect(LEFT_FOR_THE_PORT.filter(file => known.some(site => site.file === file && site.kind === 'ps'))).toEqual([])
    expect(LEFT_FOR_THE_PORT.length).toBeGreaterThan(processTableEntries.length)
    expect(known.length).toBeLessThanOrEqual(KNOWN_ENTRIES_AT_BASE)
    expect(known.filter(site => site.kind !== 'imported-judge').length).toBeLessThan(KNOWN_ENTRIES_AT_BASE)
  })
})
