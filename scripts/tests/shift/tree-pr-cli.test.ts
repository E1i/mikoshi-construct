import type { TreePrCliPorts } from '../../shift/tree-pr-cli.js'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { openBus } from '../../bus/db.js'
import { busCardStopped, busPrOpened, PREFIX, runTreePr } from '../../shift/tree-pr-cli.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function untouchable(): never {
  throw new Error('no git or gh call is expected')
}

interface ShiftedDiff {
  contour: 'cheap' | 'ladder'
  files: { path: string, additions: number, deletions: number, status?: string }[]
  patch: string
}

const SHRUNK_TEST = 'scripts/tests/shift/x.test.ts'
const CARD_TAIL = '· depends — · blocks —'
const OPENED = `Opened by the shift from the card's worktree and branch after its session ended.`

const PATH_LINES: Record<string, { diff: ShiftedDiff, cardBody?: string, line: string }> = {
  'tests shrunk on a cheap card with no assertion removed': {
    diff: { contour: 'cheap', files: [{ path: SHRUNK_TEST, additions: 4, deletions: 1 }, { path: 'scripts/shift/x.ts', additions: 2, deletions: 0 }], patch: `--- a/${SHRUNK_TEST}\n+++ b/${SHRUNK_TEST}\n@@ -3 +3,4 @@\n-import { a } from './a.js'\n+import { a, b } from './a.js'\n` },
    line: `Path: cheap · MORSE predicts ladder by rule tests-shrunk (${SHRUNK_TEST}) · cheap holds: the shrunk test files are ${SHRUNK_TEST}, and every line the diff removes from them is an import or blank`,
  },
  'a diff MORSE refuses on a cheap card': {
    diff: { contour: 'cheap', files: [{ path: 'scripts/x.sh', additions: 0, deletions: 0, status: 'T' }], patch: '' },
    line: 'Path: cheap · MORSE gave no prediction: unhandled git status T for scripts/x.sh · the cheap path is held without a named reason',
  },
  'scripts on a ladder card': {
    diff: { contour: 'ladder', files: [{ path: 'scripts/shift/x.ts', additions: 1, deletions: 0 }], patch: '' },
    line: `Path: ladder · MORSE predicts ladder by rule doubt (no test beside: scripts/shift/x.ts) · the card's contour and MORSE agree`,
  },
  'scripts on a cheap card that names its D-76 reason': {
    diff: { contour: 'cheap', files: [{ path: 'scripts/shift/x.ts', additions: 1, deletions: 0 }], patch: '' },
    cardBody: 'Do x.\nPath (D-76): cheap, one guard line the witness covers',
    line: `Path: cheap · MORSE predicts ladder by rule doubt (no test beside: scripts/shift/x.ts) · cheap holds by the card's D-76 reason: cheap, one guard line the witness covers`,
  },
  'docs only on a cheap card': {
    diff: { contour: 'cheap', files: [{ path: 'docs/x.md', additions: 1, deletions: 0 }], patch: '' },
    line: `Path: cheap · MORSE predicts cheap by rule docs-only (docs/x.md) · the card's contour and MORSE agree`,
  },
  'docs only on a ladder card': {
    diff: { contour: 'ladder', files: [{ path: 'docs/x.md', additions: 1, deletions: 0 }], patch: '' },
    line: 'Path: ladder · MORSE predicts cheap by rule docs-only (docs/x.md) · the card takes the ladder by its contour where MORSE predicts cheap',
  },
}

const MATRIX_GAP = (file: string): string => `the code matrix count line ■ n □ n · n its change to ${file} requires (architecture/code-matrix.md)`
const D76_GAP = 'the D-76 reason the card holds the cheap path where MORSE predicts the ladder'
const CHANGESET_GAP = (file: string): string => `the changeset its change to the published ${file} requires`
const ASSERTION_REMOVED = `--- a/${SHRUNK_TEST}\n+++ b/${SHRUNK_TEST}\n@@ -9 +8,0 @@\n-    expect(code).toBe(0)\n`

const FORMAT_GAPS: Record<string, { diff: ShiftedDiff, gaps: string[] }> = {
  'src on a ladder card without a changeset': {
    diff: { contour: 'ladder', files: [{ path: 'src/x.ts', additions: 1, deletions: 0 }], patch: '' },
    gaps: [MATRIX_GAP('src/x.ts'), CHANGESET_GAP('src/x.ts')],
  },
  'src on a ladder card with a changeset': {
    diff: { contour: 'ladder', files: [{ path: '.changeset/x.md', additions: 5, deletions: 0, status: 'A' }, { path: 'src/x.ts', additions: 1, deletions: 0 }], patch: '' },
    gaps: [MATRIX_GAP('src/x.ts')],
  },
  'src on a ladder card whose only changeset file is the readme': {
    diff: { contour: 'ladder', files: [{ path: '.changeset/README.md', additions: 1, deletions: 0, status: 'A' }, { path: 'src/x.ts', additions: 1, deletions: 0 }], patch: '' },
    gaps: [MATRIX_GAP('src/x.ts'), CHANGESET_GAP('src/x.ts')],
  },
  'templates on a ladder card whose changeset is deleted': {
    diff: { contour: 'ladder', files: [{ path: '.changeset/x.md', additions: 0, deletions: 5, status: 'D' }, { path: 'templates/base/x.eta', additions: 1, deletions: 0 }], patch: '' },
    gaps: [MATRIX_GAP('templates/base/x.eta'), CHANGESET_GAP('templates/base/x.eta')],
  },
  'src on a cheap card': {
    diff: { contour: 'cheap', files: [{ path: 'src/x.ts', additions: 1, deletions: 0 }], patch: '' },
    gaps: [MATRIX_GAP('src/x.ts'), D76_GAP, CHANGESET_GAP('src/x.ts')],
  },
  'tests shrunk on a cheap card with an assertion removed': {
    diff: { contour: 'cheap', files: [{ path: SHRUNK_TEST, additions: 0, deletions: 1 }], patch: ASSERTION_REMOVED },
    gaps: [D76_GAP],
  },
  'tests shrunk on a cheap card by a removed expectation-table row': {
    diff: { contour: 'cheap', files: [{ path: SHRUNK_TEST, additions: 0, deletions: 1 }], patch: `--- a/${SHRUNK_TEST}\n+++ b/${SHRUNK_TEST}\n@@ -20 +19,0 @@\n-  'src on a cheap card': { diff: d, line: 'x' },\n` },
    gaps: [D76_GAP],
  },
  'tests shrunk on a cheap card by a skipped test': {
    diff: { contour: 'cheap', files: [{ path: SHRUNK_TEST, additions: 1, deletions: 1 }], patch: `--- a/${SHRUNK_TEST}\n+++ b/${SHRUNK_TEST}\n@@ -30 +30 @@\n-  it('x', () => {\n+  it.skip('x', () => {\n` },
    gaps: [D76_GAP],
  },
}

function NOT_OPENED(): void {}

function NOT_STOPPED(): void {}

function shiftedPorts(diff: ShiftedDiff, bodies: string[]): TreePrCliPorts {
  return {
    opened: NOT_OPENED,
    stopped: NOT_STOPPED,
    git: (_cwd, args) => {
      if (args[0] === 'status')
        return ''
      if (args[0] === 'rev-list')
        return '1\n'
      if (args[0] === 'show' && args[1] === 'HEAD:package.json')
        return JSON.stringify({ files: ['dist', 'templates'] })
      if (args.includes('--name-status'))
        return diff.files.map(file => `${file.status ?? 'M'}\0${file.path}\0`).join('')
      if (args.includes('--numstat'))
        return diff.files.map(file => `${file.additions}\t${file.deletions}\t${file.path}\0`).join('')
      if (args.includes('-U0'))
        return diff.patch
      return ''
    },
    gh: (args) => {
      if (args[1] === 'list')
        return '[]'
      bodies.push(args[args.indexOf('--body') + 1]!)
      return 'https://github.com/o/r/pull/901\n'
    },
  }
}

function parkCard(root: string, contour: ShiftedDiff['contour'], body = 'Do x.'): { cardFile: string, cardLine: string } {
  const cardLine = `#951 x [implement/netwatch/S/${contour}/auto] ${CARD_TAIL}`
  const cardFile = path.join(root, 'lane-q', '951.md')
  mkdirSync(path.dirname(cardFile), { recursive: true })
  writeFileSync(cardFile, `card: ${cardLine}\nbranch: feat/x\ntouches: scripts/shift/x.ts\ncontinue: stop\nwho: shift\n\n${body}\n`)
  return { cardFile, cardLine }
}

describe('tree-pr for a finished card session', () => {
  it('a card file that moved while the session ran is a problem line, not a stack trace', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'tree-pr-cli-'))
    roots.push(root)
    const cardFile = path.join(root, 'lane-q', '951.md')
    const lines: string[] = []
    const stops: [number, string][] = []

    const code = runTreePr([cardFile, root], { git: untouchable, gh: untouchable, opened: untouchable, stopped: (cardId, why) => stops.push([cardId, why]) }, line => lines.push(line))

    const why = `the card file ${cardFile} is gone (moved to another lane or archived while the session ran); the tree is left uncommitted`
    expect({ code, lines, stops }).toEqual({ code: 1, lines: [`${PREFIX}951.md: ${why}`], stops: [[951, why]] })
  })

  it('a card file the grammar refuses gives card.stopped with the grammar\'s reason', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'tree-pr-cli-'))
    roots.push(root)
    const cardFile = path.join(root, 'lane-q', '951.md')
    mkdirSync(path.dirname(cardFile), { recursive: true })
    writeFileSync(cardFile, 'not a card\n')
    const lines: string[] = []
    const stops: [number, string][] = []

    const code = runTreePr([cardFile, root], { git: untouchable, gh: untouchable, opened: untouchable, stopped: (cardId, why) => stops.push([cardId, why]) }, line => lines.push(line))

    expect({ code, stops: stops.map(([cardId]) => cardId), line: lines[0] === `${PREFIX}951.md: ${stops[0]?.[1]}` }).toEqual({ code: 1, stops: [951], line: true })
  })

  it('a refusal for a card file whose name is no card number exits 1 and stops no card', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'tree-pr-cli-'))
    roots.push(root)
    const lines: string[] = []

    const code = runTreePr([path.join(root, 'lane-q', 'notes.md'), root], { git: untouchable, gh: untouchable, opened: untouchable, stopped: untouchable }, line => lines.push(line))

    expect({ code, lines: lines.length }).toEqual({ code: 1, lines: 1 })
  })

  it('a tree-pr refusal after a launched session gives card.stopped with its reason', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'tree-pr-cli-'))
    roots.push(root)
    const { diff, gaps } = FORMAT_GAPS['tests shrunk on a cheap card with an assertion removed']!
    const { cardFile } = parkCard(root, diff.contour)
    const busPath = path.join(root, 'bus.db')
    const bus = { busPath, pid: 4242, now: () => new Date('2026-10-20T05:00:00.000Z'), err: untouchable }

    const code = runTreePr([cardFile, root], { ...shiftedPorts(diff, []), opened: untouchable, stopped: busCardStopped(bus) }, () => {})

    const db = openBus(busPath)
    const events = db.prepare(`SELECT type, actor, card_id, pr, dedupe_key, payload FROM events WHERE type = 'card.stopped'`).all()
    db.close()
    const detail = `tree-pr: card #951: the shift opened no pull request for feat/x: it lacks ${gaps.join('; ')}`
    expect({ code, events }).toEqual({ code: 1, events: [{ type: 'card.stopped', actor: 'worker:shift:4242', card_id: 951, pr: null, dedupe_key: 'card.stopped:tree-pr:951:2026-10-20T05:00:00.000Z', payload: JSON.stringify({ reason: 'fault', detail }) }] })
  })

  it('a pull request opened or a clean tree writes no card.stopped', () => {
    const { diff } = PATH_LINES['scripts on a ladder card']!
    const observed = [diff, { ...diff, files: [] }].map((shifted) => {
      const root = mkdtempSync(path.join(tmpdir(), 'tree-pr-cli-'))
      roots.push(root)
      const { cardFile } = parkCard(root, shifted.contour)
      const ports = shiftedPorts(shifted, [])
      return runTreePr([cardFile, root], { ...ports, git: (cwd, args) => args[0] === 'rev-list' && shifted.files.length === 0 ? '0\n' : ports.git(cwd, args), stopped: untouchable }, () => {})
    })

    expect(observed).toEqual([0, 0])
  })

  it('the PR body names the path and its reason after the card line', () => {
    const observed = Object.fromEntries(Object.entries(PATH_LINES).map(([name, { diff, cardBody }]) => {
      const root = mkdtempSync(path.join(tmpdir(), 'tree-pr-cli-'))
      roots.push(root)
      const { cardFile, cardLine } = parkCard(root, diff.contour, cardBody)
      const bodies: string[] = []
      const lines: string[] = []

      const code = runTreePr([cardFile, root], shiftedPorts(diff, bodies), line => lines.push(line))

      return [name, { code, lines, bodies: bodies.map(body => body.replace(cardLine, '<card>')) }]
    }))

    expect(observed).toEqual(Object.fromEntries(Object.entries(PATH_LINES).map(([name, { line }]) => [name, { code: 0, lines: [`${PREFIX}951.md: PR #901`], bodies: [`<card>\n\n${line}\n\n${OPENED}`] }])))
  })

  it('tree-pr refuses a body without the matrix count line, the D-76 path reason or the changeset its change requires', () => {
    const observed = Object.fromEntries(Object.entries(FORMAT_GAPS).map(([name, { diff }]) => {
      const root = mkdtempSync(path.join(tmpdir(), 'tree-pr-cli-'))
      roots.push(root)
      const { cardFile } = parkCard(root, diff.contour)
      const bodies: string[] = []
      const lines: string[] = []

      const code = runTreePr([cardFile, root], shiftedPorts(diff, bodies), line => lines.push(line))

      return [name, { code, lines, bodies }]
    }))

    expect(observed).toEqual(Object.fromEntries(Object.entries(FORMAT_GAPS).map(([name, { gaps }]) => [name, { code: 1, lines: [`${PREFIX}951.md: the shift opened no pull request for feat/x: it lacks ${gaps.join('; ')}`], bodies: [] }])))
  })

  it('the PR body carries the matrix count line of the session report', () => {
    const { diff, line } = PATH_LINES['scripts on a ladder card']!
    const reports: Record<string, { report: string | null, tail: string }> = {
      'a report with the matrix': { report: 'contract: x\n\n| | M1 | M2 |\n| M1 | ■ | □ |\n\n■ 3 □ 1 · 6\n\nverification: run\n', tail: '\n\n■ 3 □ 1 · 6' },
      'a report without the matrix': { report: 'contract: x\nverification: run\n', tail: '' },
      'no report on disk': { report: null, tail: '' },
    }
    const observed = Object.fromEntries(Object.entries(reports).map(([name, { report }]) => {
      const root = mkdtempSync(path.join(tmpdir(), 'tree-pr-cli-'))
      roots.push(root)
      const { cardFile, cardLine } = parkCard(root, diff.contour)
      const reportFile = path.join(root, 'report-951.md')
      if (report !== null)
        writeFileSync(reportFile, report)
      const bodies: string[] = []

      runTreePr([cardFile, root, reportFile], shiftedPorts(diff, bodies), () => {})

      return [name, bodies.map(body => body.replace(cardLine, '<card>'))]
    }))

    expect(observed).toEqual(Object.fromEntries(Object.entries(reports).map(([name, { tail }]) => [name, [`<card>\n\n${line}\n\n${OPENED}${tail}`]])))
  })

  it('opening the pull request writes pr.opened to the bus', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'tree-pr-cli-'))
    roots.push(root)
    const { diff } = PATH_LINES['scripts on a ladder card']!
    const { cardFile } = parkCard(root, diff.contour)
    const busPath = path.join(root, 'bus.db')
    const errors: string[] = []

    const code = runTreePr([cardFile, root], { ...shiftedPorts(diff, []), opened: busPrOpened({ busPath, pid: 4242, now: () => new Date('2026-10-12T07:00:00.000Z'), err: line => errors.push(line) }) }, () => {})

    const db = openBus(busPath)
    const events = db.prepare(`SELECT type, actor, card_id, pr, dedupe_key, payload FROM events WHERE type = 'pr.opened'`).all()
    db.close()
    expect({ code, errors, events }).toEqual({ code: 0, errors: [], events: [{ type: 'pr.opened', actor: 'worker:shift:4242', card_id: 951, pr: 901, dedupe_key: 'pr.opened:951:901', payload: '{"pr":901}' }] })
  })

  it('a pr.opened the bus refuses is a line, and the pull request stands', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'tree-pr-cli-'))
    roots.push(root)
    const { diff } = PATH_LINES['scripts on a ladder card']!
    const { cardFile } = parkCard(root, diff.contour)
    const blocked = path.join(root, 'blocked')
    writeFileSync(blocked, '')
    const errors: string[] = []
    const lines: string[] = []

    const code = runTreePr([cardFile, root], { ...shiftedPorts(diff, []), opened: busPrOpened({ busPath: path.join(blocked, 'bus.db'), pid: 4242, now: () => new Date(), err: line => errors.push(line) }) }, line => lines.push(line))

    expect({ code, lines, errors }).toEqual({ code: 0, lines: [`${PREFIX}951.md: PR #901`], errors: [expect.stringContaining(`pr.opened of PR #901 not written to ${path.join(blocked, 'bus.db')}`)] })
  })
})
