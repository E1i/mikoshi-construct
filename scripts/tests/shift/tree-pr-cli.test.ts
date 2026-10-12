import type { TreePrPorts } from '../../shift/tree-pr.js'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PREFIX, runTreePr } from '../../shift/tree-pr-cli.js'

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

const PATH_LINES: Record<string, { diff: ShiftedDiff, line: string }> = {
  'tests shrunk on a cheap card with no assertion removed': {
    diff: { contour: 'cheap', files: [{ path: SHRUNK_TEST, additions: 4, deletions: 1 }, { path: 'scripts/shift/x.ts', additions: 2, deletions: 0 }], patch: `--- a/${SHRUNK_TEST}\n+++ b/${SHRUNK_TEST}\n@@ -3 +3,4 @@\n-import { a } from './a.js'\n+import { a, b } from './a.js'\n` },
    line: `Path: cheap · MORSE predicts ladder by rule tests-shrunk (${SHRUNK_TEST}) · cheap holds: the shrunk test files are ${SHRUNK_TEST}, and every line the diff removes from them is an import or blank`,
  },
  'tests shrunk on a cheap card with an assertion removed': {
    diff: { contour: 'cheap', files: [{ path: SHRUNK_TEST, additions: 0, deletions: 1 }], patch: `--- a/${SHRUNK_TEST}\n+++ b/${SHRUNK_TEST}\n@@ -9 +8,0 @@\n-    expect(code).toBe(0)\n` },
    line: `Path: cheap · MORSE predicts ladder by rule tests-shrunk (${SHRUNK_TEST}) · the cheap path is held without a named reason`,
  },
  'tests shrunk on a cheap card by a removed expectation-table row': {
    diff: { contour: 'cheap', files: [{ path: SHRUNK_TEST, additions: 0, deletions: 1 }], patch: `--- a/${SHRUNK_TEST}\n+++ b/${SHRUNK_TEST}\n@@ -20 +19,0 @@\n-  'src on a cheap card': { diff: d, line: 'x' },\n` },
    line: `Path: cheap · MORSE predicts ladder by rule tests-shrunk (${SHRUNK_TEST}) · the cheap path is held without a named reason`,
  },
  'tests shrunk on a cheap card by a skipped test': {
    diff: { contour: 'cheap', files: [{ path: SHRUNK_TEST, additions: 1, deletions: 1 }], patch: `--- a/${SHRUNK_TEST}\n+++ b/${SHRUNK_TEST}\n@@ -30 +30 @@\n-  it('x', () => {\n+  it.skip('x', () => {\n` },
    line: `Path: cheap · MORSE predicts ladder by rule tests-shrunk (${SHRUNK_TEST}) · the cheap path is held without a named reason`,
  },
  'src on a ladder card': {
    diff: { contour: 'ladder', files: [{ path: 'src/x.ts', additions: 1, deletions: 0 }], patch: '' },
    line: `Path: ladder · MORSE predicts ladder by rule src (src/x.ts) · the card's contour and MORSE agree`,
  },
  'a diff MORSE refuses on a cheap card': {
    diff: { contour: 'cheap', files: [{ path: 'scripts/x.sh', additions: 0, deletions: 0, status: 'T' }], patch: '' },
    line: 'Path: cheap · MORSE gave no prediction: unhandled git status T for scripts/x.sh · the cheap path is held without a named reason',
  },
  'src on a cheap card': {
    diff: { contour: 'cheap', files: [{ path: 'src/x.ts', additions: 1, deletions: 0 }], patch: '' },
    line: 'Path: cheap · MORSE predicts ladder by rule src (src/x.ts) · the cheap path is held without a named reason',
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

function shiftedPorts(diff: ShiftedDiff, bodies: string[]): TreePrPorts {
  return {
    git: (_cwd, args) => {
      if (args[0] === 'status')
        return ''
      if (args[0] === 'rev-list')
        return '1\n'
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

function parkCard(root: string, contour: ShiftedDiff['contour']): { cardFile: string, cardLine: string } {
  const cardLine = `#951 x [implement/netwatch/S/${contour}/auto] ${CARD_TAIL}`
  const cardFile = path.join(root, 'lane-q', '951.md')
  mkdirSync(path.dirname(cardFile), { recursive: true })
  writeFileSync(cardFile, `card: ${cardLine}\nbranch: feat/x\ntouches: scripts/shift/x.ts\ncontinue: stop\nwho: shift\n\nDo x.\n`)
  return { cardFile, cardLine }
}

describe('tree-pr for a finished card session', () => {
  it('a card file that moved while the session ran is a problem line, not a stack trace', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'tree-pr-cli-'))
    roots.push(root)
    const cardFile = path.join(root, 'lane-q', '951.md')
    const lines: string[] = []

    const code = runTreePr([cardFile, root], { git: untouchable, gh: untouchable }, line => lines.push(line))

    expect({ code, lines }).toEqual({ code: 1, lines: [`${PREFIX}951.md: the card file ${cardFile} is gone (moved to another lane or archived while the session ran); the tree is left uncommitted`] })
  })

  it('the PR body names the path and its reason after the card line', () => {
    const observed = Object.fromEntries(Object.entries(PATH_LINES).map(([name, { diff }]) => {
      const root = mkdtempSync(path.join(tmpdir(), 'tree-pr-cli-'))
      roots.push(root)
      const { cardFile, cardLine } = parkCard(root, diff.contour)
      const bodies: string[] = []
      const lines: string[] = []

      const code = runTreePr([cardFile, root], shiftedPorts(diff, bodies), line => lines.push(line))

      return [name, { code, lines, bodies: bodies.map(body => body.replace(cardLine, '<card>')) }]
    }))

    expect(observed).toEqual(Object.fromEntries(Object.entries(PATH_LINES).map(([name, { line }]) => [name, { code: 0, lines: [`${PREFIX}951.md: PR #901`], bodies: [`<card>\n\n${line}\n\n${OPENED}`] }])))
  })
})
