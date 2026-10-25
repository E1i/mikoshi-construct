import type { PrOpenedBus, TreePrCliPorts } from '../../nodes/launch/tree-pr-cli.js'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appendEvent, openBus } from '../../core/db.js'
import { CARD_PERMISSION_MODE } from '../../nodes/launch/launch-starter.js'
import { busCardStopped, busPrOpened, claudeResume, PREFIX, runTreePr } from '../../nodes/launch/tree-pr-cli.js'
import { CARD_VARIABLE } from '../../ports/session.js'

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

const ASSERTION_REMOVED = `--- a/${SHRUNK_TEST}\n+++ b/${SHRUNK_TEST}\n@@ -9 +8,0 @@\n-    expect(code).toBe(0)\n`
const SHRUNK_BY_DEFAULT = `Path: cheap · MORSE predicts ladder by rule tests-shrunk (${SHRUNK_TEST}) · cheap holds as the default path of D-224`

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
  'scripts on a cheap card that names no D-76 reason': {
    diff: { contour: 'cheap', files: [{ path: 'scripts/shift/x.ts', additions: 1, deletions: 0 }], patch: '' },
    line: `Path: cheap · MORSE predicts ladder by rule doubt (no test beside: scripts/shift/x.ts) · cheap holds as the default path of D-224`,
  },
  'tests shrunk on a cheap card with an assertion removed': {
    diff: { contour: 'cheap', files: [{ path: SHRUNK_TEST, additions: 0, deletions: 1 }], patch: ASSERTION_REMOVED },
    line: SHRUNK_BY_DEFAULT,
  },
  'tests shrunk on a cheap card by a removed expectation-table row': {
    diff: { contour: 'cheap', files: [{ path: SHRUNK_TEST, additions: 0, deletions: 1 }], patch: `--- a/${SHRUNK_TEST}\n+++ b/${SHRUNK_TEST}\n@@ -20 +19,0 @@\n-  'src on a cheap card': { diff: d, line: 'x' },\n` },
    line: SHRUNK_BY_DEFAULT,
  },
  'tests shrunk on a cheap card by a skipped test': {
    diff: { contour: 'cheap', files: [{ path: SHRUNK_TEST, additions: 1, deletions: 1 }], patch: `--- a/${SHRUNK_TEST}\n+++ b/${SHRUNK_TEST}\n@@ -30 +30 @@\n-  it('x', () => {\n+  it.skip('x', () => {\n` },
    line: SHRUNK_BY_DEFAULT,
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
const CHANGESET_GAP = (file: string): string => `the changeset its change to the published ${file} requires`

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
    gaps: [MATRIX_GAP('src/x.ts'), CHANGESET_GAP('src/x.ts')],
  },
}

function NOT_OPENED(): void {}

function NOT_STOPPED(): void {}

function NOT_RESUMED(): boolean {
  return false
}

function shiftedPorts(diff: ShiftedDiff, bodies: string[], cardText: string | null = null): TreePrCliPorts {
  return {
    card: cardId => cardId === 951 ? cardText : null,
    opened: NOT_OPENED,
    stopped: NOT_STOPPED,
    waited: NOT_STOPPED,
    lastRefusal: () => null,
    returned: NOT_STOPPED,
    resume: NOT_RESUMED,
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

function busCard(contour: ShiftedDiff['contour'], body = 'Do x.'): { cardText: string, cardLine: string } {
  const cardLine = `#951 x [implement/netwatch/S/${contour}/auto] ${CARD_TAIL}`
  return { cardText: `card: ${cardLine}\nbranch: feat/x\ntouches: scripts/shift/x.ts, scripts/tests/shift/x.test.ts, scripts/x.sh, src/x.ts, docs/x.md, templates/base/x.eta, .changeset/**\ncontinue: stop\nwho: shift\n\n${body}\n`, cardLine }
}

const NO_CARD = { git: untouchable, gh: untouchable, opened: untouchable, waited: untouchable, lastRefusal: untouchable, returned: untouchable, resume: untouchable }

const START_KEY = 'card.started:launch:951:1'

function launchedBus(root: string, cardId: number): PrOpenedBus {
  const busPath = path.join(root, 'bus.db')
  const db = openBus(busPath)
  appendEvent(db, { ts: '2026-10-20T04:00:00.000Z', type: 'card.started', actor: 'worker:launch:1', cardId, pr: null, head: null, dedupeKey: START_KEY.replace('951', String(cardId)), payload: {}, legacy: false })
  db.close()
  return { busPath, pid: 4242, now: () => new Date('2026-10-20T05:00:00.000Z'), err: untouchable }
}

function stopsOn(busPath: string): Record<string, unknown>[] {
  const db = openBus(busPath)
  const stops = db.prepare(`SELECT type, actor, card_id, pr, dedupe_key, payload FROM events WHERE type = 'card.stopped'`).all()
  db.close()
  return stops
}

describe('tree-pr for a finished card session', () => {
  it('a card the bus holds no body of is a problem line, not a stack trace', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'tree-pr-cli-'))
    roots.push(root)
    const lines: string[] = []
    const stops: [number, string][] = []

    const code = runTreePr(['951', root], { ...NO_CARD, card: () => null, stopped: (cardId, why) => stops.push([cardId, why]) }, line => lines.push(line))

    const why = 'the bus holds no card body of card #951 that parses; the tree is left uncommitted'
    expect({ code, lines, stops }).toEqual({ code: 1, lines: [`${PREFIX}card #951: ${why}`], stops: [[951, why]] })
  })

  it('a card body the grammar refuses gives card.stopped with the grammar\'s reason', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'tree-pr-cli-'))
    roots.push(root)
    const lines: string[] = []
    const stops: [number, string][] = []

    const code = runTreePr(['951', root], { ...NO_CARD, card: () => 'not a card\n', stopped: (cardId, why) => stops.push([cardId, why]) }, line => lines.push(line))

    expect({ code, stops: stops.map(([cardId]) => cardId), line: lines[0] === `${PREFIX}card #951: ${stops[0]?.[1]}` }).toEqual({ code: 1, stops: [951], line: true })
  })

  it('a first argument that is no card number is the usage line, exit 2, and stops no card', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'tree-pr-cli-'))
    roots.push(root)
    const lines: string[] = []

    const codes = [path.join(root, 'lane-q', '951.md'), 'notes', '0'].map(word => runTreePr([word, root], { ...NO_CARD, card: untouchable, stopped: untouchable }, line => lines.push(line)))

    expect({ codes, lines: [...new Set(lines)] }).toEqual({ codes: [2, 2, 2], lines: [`${PREFIX}usage: tree-pr <card id> <worktree> [<session report>]`] })
  })

  it('a class c tree-pr refusal after a launched session gives card.stopped with its reason and code', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'tree-pr-cli-'))
    roots.push(root)
    const { diff } = PATH_LINES['scripts on a ladder card']!
    const { cardText } = busCard(diff.contour)
    const bus = launchedBus(root, 951)
    const ports = shiftedPorts(diff, [], cardText)

    const codes = [1, 2].map(() => runTreePr(['951', root], { ...ports, gh: args => args[1] === 'list' ? '[]' : 'nothing\n', opened: untouchable, stopped: busCardStopped(bus) }, () => {}))

    const detail = 'tree-pr: card #951: gh pr create printed no pull request URL: nothing'
    expect({ codes, events: stopsOn(bus.busPath) }).toEqual({ codes: [1, 1], events: [{ type: 'card.stopped', actor: 'worker:shift:4242', card_id: 951, pr: null, dedupe_key: `card.stopped:tree-pr:${START_KEY}`, payload: JSON.stringify({ reason: 'fault', detail, code: 'c:no-pr-url' }) }] })
  })

  it('a card body the grammar refuses after a launched session writes card.stopped to the bus', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'tree-pr-cli-'))
    roots.push(root)
    const bus = launchedBus(root, 951)

    const code = runTreePr(['951', root], { ...NO_CARD, card: () => 'not a card\n', stopped: busCardStopped(bus) }, () => {})

    expect({ code, stops: stopsOn(bus.busPath).map(stop => stop.dedupe_key) }).toEqual({ code: 1, stops: [`card.stopped:tree-pr:${START_KEY}`] })
  })

  it('a refusal after a relaunch keys card.stopped on the latest card.started, once per start', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'tree-pr-cli-'))
    roots.push(root)
    const bus = launchedBus(root, 951)
    const ports = { ...NO_CARD, card: () => 'not a card\n', stopped: busCardStopped(bus) }
    const relaunchKey = 'card.started:launch:951:2'

    const firstCode = runTreePr(['951', root], ports, () => {})
    const db = openBus(bus.busPath)
    appendEvent(db, { ts: '2026-10-20T04:30:00.000Z', type: 'card.started', actor: 'worker:launch:1', cardId: 951, pr: null, head: null, dedupeKey: relaunchKey, payload: {}, legacy: false })
    appendEvent(db, { ts: '2026-10-20T04:40:00.000Z', type: 'pr.opened', actor: 'worker:shift:1', cardId: 951, pr: 901, head: null, dedupeKey: 'pr.opened:951:901', payload: { pr: 901 }, legacy: false })
    db.close()
    const laterCodes = [1, 2].map(() => runTreePr(['951', root], ports, () => {}))

    expect({ codes: [firstCode, ...laterCodes], stops: stopsOn(bus.busPath).map(stop => stop.dedupe_key) }).toEqual({ codes: [1, 1, 1], stops: [`card.stopped:tree-pr:${START_KEY}`, `card.stopped:tree-pr:${relaunchKey}`] })
  })

  it('a first argument that is no card number writes nothing to the bus', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'tree-pr-cli-'))
    roots.push(root)
    const bus = launchedBus(root, 951)
    const lines: string[] = []

    const code = runTreePr([path.join(root, 'lane-q', 'notes.md'), root], { ...NO_CARD, card: untouchable, stopped: busCardStopped(bus) }, line => lines.push(line))

    expect({ code, lines: lines.length, stops: stopsOn(bus.busPath) }).toEqual({ code: 2, lines: 1, stops: [] })
  })

  it('a refusal on a card the bus never started is a line, not a card.stopped', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'tree-pr-cli-'))
    roots.push(root)
    const errs: string[] = []
    const bus = { ...launchedBus(root, 952), err: (line: string) => errs.push(line) }

    const code = runTreePr(['951', root], { ...NO_CARD, card: () => null, stopped: busCardStopped(bus) }, () => {})

    expect({ code, stops: stopsOn(bus.busPath), errs }).toEqual({ code: 1, stops: [], errs: [`${PREFIX}card.stopped of card #951 not written to ${bus.busPath}: card #951 has no card.started to stop`] })
  })

  it('a pull request opened or a clean tree writes no card.stopped', () => {
    const { diff } = PATH_LINES['scripts on a ladder card']!
    const observed = [diff, { ...diff, files: [] }].map((shifted) => {
      const root = mkdtempSync(path.join(tmpdir(), 'tree-pr-cli-'))
      roots.push(root)
      const ports = shiftedPorts(shifted, [], busCard(shifted.contour).cardText)
      return runTreePr(['951', root], { ...ports, git: (cwd, args) => args[0] === 'rev-list' && shifted.files.length === 0 ? '0\n' : ports.git(cwd, args), stopped: untouchable }, () => {})
    })

    expect(observed).toEqual([0, 0])
  })

  it('the PR body names the path and its reason after the card line', () => {
    const observed = Object.fromEntries(Object.entries(PATH_LINES).map(([name, { diff, cardBody }]) => {
      const root = mkdtempSync(path.join(tmpdir(), 'tree-pr-cli-'))
      roots.push(root)
      const { cardText, cardLine } = busCard(diff.contour, cardBody)
      const bodies: string[] = []
      const lines: string[] = []

      const code = runTreePr(['951', root], shiftedPorts(diff, bodies, cardText), line => lines.push(line))

      return [name, { code, lines, bodies: bodies.map(body => body.replace(cardLine, '<card>')) }]
    }))

    expect(observed).toEqual(Object.fromEntries(Object.entries(PATH_LINES).map(([name, { line }]) => [name, { code: 0, lines: [`${PREFIX}card #951: PR #901`], bodies: [`<card>\n\n${line}\n\n${OPENED}`] }])))
  })

  it('tree-pr returns to its session a body without the matrix count line or the changeset its change requires', () => {
    const observed = Object.fromEntries(Object.entries(FORMAT_GAPS).map(([name, { diff }]) => {
      const root = mkdtempSync(path.join(tmpdir(), 'tree-pr-cli-'))
      roots.push(root)
      const bodies: string[] = []
      const lines: string[] = []

      const code = runTreePr(['951', root], shiftedPorts(diff, bodies, busCard(diff.contour).cardText), line => lines.push(line))

      return [name, { code, returned: lines[0]?.replace(/returned to its session for \S+: /, ''), bodies }]
    }))

    expect(observed).toEqual(Object.fromEntries(Object.entries(FORMAT_GAPS).map(([name, { gaps }]) => [name, { code: 1, returned: `${PREFIX}card #951: the shift opened no pull request for feat/x: it lacks ${gaps.join('; ')}`, bodies: [] }])))
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
      const { cardText, cardLine } = busCard(diff.contour)
      const reportFile = path.join(root, 'report-951.md')
      if (report !== null)
        writeFileSync(reportFile, report)
      const bodies: string[] = []

      runTreePr(['951', root, reportFile], shiftedPorts(diff, bodies, cardText), () => {})

      return [name, bodies.map(body => body.replace(cardLine, '<card>'))]
    }))

    expect(observed).toEqual(Object.fromEntries(Object.entries(reports).map(([name, { tail }]) => [name, [`<card>\n\n${line}\n\n${OPENED}${tail}`]])))
  })

  it('opening the pull request writes pr.opened to the bus', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'tree-pr-cli-'))
    roots.push(root)
    const { diff } = PATH_LINES['scripts on a ladder card']!
    const busPath = path.join(root, 'bus.db')
    const errors: string[] = []

    const code = runTreePr(['951', root], { ...shiftedPorts(diff, [], busCard(diff.contour).cardText), opened: busPrOpened({ busPath, pid: 4242, now: () => new Date('2026-10-12T07:00:00.000Z'), err: line => errors.push(line) }) }, () => {})

    const db = openBus(busPath)
    const events = db.prepare(`SELECT type, actor, card_id, pr, dedupe_key, payload FROM events WHERE type = 'pr.opened'`).all()
    db.close()
    expect({ code, errors, events }).toEqual({ code: 0, errors: [], events: [{ type: 'pr.opened', actor: 'worker:shift:4242', card_id: 951, pr: 901, dedupe_key: 'pr.opened:951:901', payload: '{"pr":901}' }] })
  })

  it('a pr.opened the bus refuses is a line, and the pull request stands', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'tree-pr-cli-'))
    roots.push(root)
    const { diff } = PATH_LINES['scripts on a ladder card']!
    const blocked = path.join(root, 'blocked')
    writeFileSync(blocked, '')
    const errors: string[] = []
    const lines: string[] = []

    const code = runTreePr(['951', root], { ...shiftedPorts(diff, [], busCard(diff.contour).cardText), opened: busPrOpened({ busPath: path.join(blocked, 'bus.db'), pid: 4242, now: () => new Date(), err: line => errors.push(line) }) }, line => lines.push(line))

    expect({ code, lines, errors }).toEqual({ code: 0, lines: [`${PREFIX}card #951: PR #901`], errors: [expect.stringContaining(`pr.opened of PR #901 not written to ${path.join(blocked, 'bus.db')}`)] })
  })
})

describe('the session a refusal returns the card to', () => {
  const SESSION = 'card-session-951'

  function resumed(script: string, ceilingMs: number) {
    const root = mkdtempSync(path.join(tmpdir(), 'tree-pr-resume-'))
    roots.push(root)
    const busPath = path.join(root, 'bus.db')
    const db = openBus(busPath)
    appendEvent(db, { ts: '2026-10-22T04:00:00.000Z', type: 'card.started', actor: 'worker:launch:1', cardId: 951, pr: null, head: null, dedupeKey: START_KEY, payload: { session: SESSION, worktree: root, branch: 'feat/x' }, legacy: false })
    db.close()
    const claude = path.join(root, 'claude')
    const seen = path.join(root, 'seen.txt')
    writeFileSync(claude, `#!/bin/sh\n${script.replaceAll('SEEN', seen)}\n`)
    chmodSync(claude, 0o755)
    const started = Date.now()
    const ran = claudeResume(busPath, claude, ceilingMs)(951, root, 'merge a fresh origin/main')
    return { ran, seen, ms: Date.now() - started }
  }

  it('resumes the card session in its tree with the card environment and the card permission mode', () => {
    const { ran, seen } = resumed(`printf '%s\\n' "$PWD" "$${CARD_VARIABLE}" "$NO_COLOR" "$@" > SEEN`, 10_000)

    const [cwd, card, noColor, ...argv] = readFileSync(seen, 'utf8').trim().split('\n')
    expect({ ran, cwd: cwd?.endsWith(path.basename(path.dirname(seen))), card, noColor, argv }).toEqual({ ran: true, cwd: true, card: '951', noColor: '1', argv: ['--permission-mode', CARD_PERMISSION_MODE, '--strict-mcp-config', '-p', '--resume', SESSION, 'merge a fresh origin/main'] })
  })

  it('a resumed card session starts with --strict-mcp-config, so no MCP server of the owner\'s user config starts in it', () => {
    const { ran, seen } = resumed(`printf '%s\\n' "$@" > SEEN`, 10_000)

    const argv = readFileSync(seen, 'utf8').trim().split('\n')
    expect({ ran, strict: argv.slice(0, argv.indexOf('--resume')).includes('--strict-mcp-config') }).toEqual({ ran: true, strict: true })
  })

  it('a returned session that hangs past its ceiling is ended and reads as not run to its end', () => {
    const { ran, ms } = resumed('exec sleep 30', 500)

    expect({ ran, endedAtTheCeiling: ms < 10_000 }).toEqual({ ran: false, endedAtTheCeiling: true })
  })
})
