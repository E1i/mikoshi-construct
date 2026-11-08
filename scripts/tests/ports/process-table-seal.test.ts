import type { LivenessKind, LivenessSite } from '../../supervisor/liveness-sites.js'
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
const JUDGEMENT_EXCUSED_BY_KIND: Partial<Record<LivenessKind, RegExp>> = {
  'kill': /\bfunction alive\(\w+: number\): boolean \{\s*try \{\s*process\.kill\(\w+, 0\)\s*return true\s*\}|\bkill\([^,()]+,\s*0\s*\)/g,
  'imported-judge': /import\s*\{[^}]*\b(?:alive|isAlive)\b[^}]*\}\s*from\s*['"][^'"]+['"]/g,
  'live-session': /\bprocess (?:alive|dead)\b/g,
}
const LIVE_SESSION_PLACES = ['scripts/ladder/watch-process.ts', 'scripts/nodes/answer/answerer.ts', 'scripts/ports/worktree.ts']
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

function withoutRecordedJudgement(file: string, text: string, known: readonly LivenessSite[]): string {
  return known.filter(site => site.file === file).flatMap(site => JUDGEMENT_EXCUSED_BY_KIND[site.kind] ?? []).reduce((rest, excused) => rest.replace(excused, ''), text)
}

function judgesByThePort(sources: ReadonlyMap<string, string>, known: readonly LivenessSite[]): string[] {
  return [...sources].filter(([file, text]) => file !== PORT && file !== LIVENESS_JUDGE && PORT_IMPORT.test(text) && LIVENESS_JUDGEMENT.test(withoutRecordedJudgement(file, text, known))).map(([file]) => file).sort()
}

function portCallers(sources: ReadonlyMap<string, string>): string[] {
  return [...sources].filter(([file, text]) => file !== PORT && PORT_IMPORT.test(text)).map(([file]) => file).sort()
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

  it('the live session detector sees the answerer, worktree and watch-process places', { timeout: SCAN_TIMEOUT }, () => {
    const liveSession = CONCEPTS.filter(concept => concept.id === 'live-session')
    const seen = Object.keys(overlapsSection(findSites(REPO_ROOT, liveSession), liveSession)['live-session']!)

    expect(LIVE_SESSION_PLACES.filter(place => !seen.includes(place))).toEqual([])
    expect(knownLivenessSites(REPO_ROOT).filter(site => site.kind === 'live-session').map(site => site.file).sort()).toEqual([...seen].sort())
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
    const known = knownLivenessSites(REPO_ROOT)
    expect(judgesByThePort(planted, known)).toEqual(['scripts/nodes/judge.ts'])

    const sources = livenessSources(REPO_ROOT)
    const listedCaller = 'scripts/window/exit.ts'
    const judgingListedCaller = new Map([[listedCaller, `${sources.get(listedCaller)}\nexport function alive(pid: number) { return rowOf(new OsProcessTable().snapshot(), pid) !== null }\n`]])
    expect(recordedInTheKnownList().has(listedCaller)).toBe(true)
    expect(judgesByThePort(judgingListedCaller, known)).toEqual([listedCaller])

    const lockByThePort = 'scripts/supervisor/bg.ts'
    const bgByThePort = new Map([[lockByThePort, sources.get(lockByThePort)!.replace('process.kill(pid, 0)', 'if (rowOf(new OsProcessTable().snapshot(), pid) === null) throw new Error()')]])
    expect(judgesByThePort(bgByThePort, known)).toEqual([lockByThePort])

    expect(judgesByThePort(sources, known)).toEqual([])
  })

  it('the seal takes its exemptions from liveness-sites.known.json', () => {
    const known = knownLivenessSites(REPO_ROOT)
    const sources = livenessSources(REPO_ROOT)
    const excused = [...new Set(known.filter(site => JUDGEMENT_EXCUSED_BY_KIND[site.kind] !== undefined).map(site => site.file))]
    const judgingWithoutTheirEntry = excused.filter(file => judgesByThePort(sources, known.filter(site => site.file !== file)).includes(file))

    expect(judgingWithoutTheirEntry).toContain('scripts/ladder/watch-process.ts')
    expect(judgingWithoutTheirEntry).toContain('scripts/supervisor/bg.ts')
    expect(judgesByThePort(sources, known)).toEqual([])
  })

  it('the known list takes the port only when more entries leave it', () => {
    const known = knownLivenessSites(REPO_ROOT)
    const processTableEntries = known.filter(site => site.kind === 'ps')
    const callers = portCallers(livenessSources(REPO_ROOT))

    expect(processTableEntries).toEqual([{ file: PORT, kind: 'ps' }])
    expect(callers.filter(file => known.some(site => site.file === file && site.kind === 'ps'))).toEqual([])
    expect(callers.length).toBeGreaterThan(processTableEntries.length)
  })
})
