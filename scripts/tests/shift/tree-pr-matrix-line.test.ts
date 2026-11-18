import type { PrOpenedBus, TreePrCliPorts } from '../../nodes/launch/tree-pr-cli.js'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { appendEvent, openBus } from '../../core/db.js'
import { CARD_STARTED, PR_OPENED } from '../../core/events.js'
import { treeReportPath } from '../../core/places.js'
import { busPrOpened, PREFIX, runTreePr } from '../../nodes/launch/tree-pr-cli.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

const COUNT_LINE = '■ 3 □ 1 · 6'
const REPORT_WITH_LINE = `contract: x\n\n${COUNT_LINE}\n\nverification: run\n`
const REPORT_WITHOUT_LINE = 'contract: x\nverification: run\n'
const MATRIX_MANIFEST = `${JSON.stringify({ harness: { command: 'pnpm run quality' }, shift: { prepush: ['pnpm run quality'], codeMatrix: 'architecture/code-matrix.md' } })}\n`
const CARD_LINE = '#951 x [implement/netwatch/S/cheap/auto] · depends — · blocks —'
const CARD_TEXT = `card: ${CARD_LINE}\nbranch: feat/x\ntouches: scripts/shift/x.ts, src/x.ts, .changeset/**\ncontinue: stop\nwho: shift\n\nDo x.\n`
const OPEN_BODY = `${CARD_LINE}\n\nPath: cheap · earlier round\n\nOpened by the shift from the card's worktree and branch after its session ended.\n`
const SRC_WITH_CHANGESET = [{ status: 'M', path: 'src/x.ts' }, { status: 'A', path: '.changeset/x.md' }]

interface Diffed {
  status: string
  path: string
}

interface GhCalls {
  created: string[]
  edited: [string, string][]
  viewed: string[]
}

function root(manifest = MATRIX_MANIFEST): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'tree-pr-matrix-'))
  roots.push(dir)
  writeFileSync(path.join(dir, 'construct.json'), manifest)
  return dir
}

function startedBus(dir: string): PrOpenedBus {
  const busPath = path.join(dir, 'bus.db')
  const db = openBus(busPath)
  appendEvent(db, { ts: '2026-11-19T04:00:00.000Z', type: CARD_STARTED, actor: 'worker:launch:1', cardId: 951, pr: null, head: null, dedupeKey: `${CARD_STARTED}:launch:951:1`, payload: {}, legacy: false })
  db.close()
  return { busPath, pid: 4242, now: () => new Date('2026-11-19T05:00:00.000Z'), err: () => {} }
}

function prOpenedOn(busPath: string): unknown[] {
  const db = openBus(busPath)
  const rows = db.prepare(`SELECT pr FROM events WHERE type = '${PR_OPENED}'`).all()
  db.close()
  return rows
}

function ports(diff: readonly Diffed[], open: number | null, calls: GhCalls): TreePrCliPorts {
  return {
    card: cardId => cardId === 951 ? CARD_TEXT : null,
    opened: () => {},
    stopped: () => {},
    waited: () => {},
    lastRefusal: () => null,
    returned: () => {},
    resume: () => false,
    git: (_cwd, args) => {
      if (args[0] === 'rev-list')
        return '1\n'
      if (args[0] === 'show' && args[1] === 'HEAD:package.json')
        return JSON.stringify({ files: ['dist', 'templates'] })
      if (args.includes('--name-status'))
        return diff.map(file => `${file.status}\0${file.path}\0`).join('')
      if (args.includes('--numstat'))
        return diff.map(file => `1\t0\t${file.path}\0`).join('')
      return ''
    },
    gh: (args) => {
      if (args[1] === 'list')
        return JSON.stringify(open === null ? [] : [{ number: open }])
      if (args[1] === 'view') {
        calls.viewed.push(args[2]!)
        return OPEN_BODY
      }
      if (args[1] === 'edit') {
        calls.edited.push([args[2]!, args[args.indexOf('--body') + 1]!])
        return ''
      }
      calls.created.push(args[args.indexOf('--body') + 1]!)
      return 'https://github.com/o/r/pull/901\n'
    },
  }
}

function noCalls(): GhCalls {
  return { created: [], edited: [], viewed: [] }
}

function reportFile(dir: string, text: string): string {
  const file = path.join(dir, 'report-951.md')
  writeFileSync(file, text)
  return file
}

describe('the shift opens no pull request the merge policy refuses for its matrix line', () => {
  it('a src change MORSE gives no prediction for opens no pull request without the matrix count line', () => {
    const dir = root()
    const bus = startedBus(dir)
    const calls = noCalls()
    const lines: string[] = []

    const code = runTreePr(['951', dir, reportFile(dir, REPORT_WITHOUT_LINE)], { ...ports([{ status: 'T', path: 'src/x.ts' }, { status: 'A', path: '.changeset/x.md' }], null, calls), opened: busPrOpened(bus) }, line => lines.push(line))

    expect({ code, returned: lines[0]?.includes('returned to its session for a:no-matrix-line'), created: calls.created, opened: prOpenedOn(bus.busPath) }).toEqual({ code: 1, returned: true, created: [], opened: [] })
  })

  it('an open pull request of a src change gets the count line of the session report before tree-pr reports it', () => {
    const dir = root()
    const calls = noCalls()
    const opened: number[] = []
    const lines: string[] = []

    const code = runTreePr(['951', dir, reportFile(dir, REPORT_WITH_LINE)], { ...ports(SRC_WITH_CHANGESET, 901, calls), opened: (_card, pr) => opened.push(pr) }, line => lines.push(line))

    expect({ code, lines, opened, edited: calls.edited, created: calls.created }).toEqual({ code: 0, lines: [`${PREFIX}card #951: PR #901`], opened: [901], edited: [['901', `${OPEN_BODY.trimEnd()}\n\n${COUNT_LINE}`]], created: [] })
  })

  it('an open pull request of a src change whose report has no count line is returned for no-matrix-line, unedited', () => {
    const dir = root()
    const calls = noCalls()
    const opened: number[] = []
    const lines: string[] = []

    const code = runTreePr(['951', dir, reportFile(dir, REPORT_WITHOUT_LINE)], { ...ports(SRC_WITH_CHANGESET, 901, calls), opened: (_card, pr) => opened.push(pr) }, line => lines.push(line))

    expect({ code, returned: lines[0]?.includes('returned to its session for a:no-matrix-line'), opened, edited: calls.edited }).toEqual({ code: 1, returned: true, opened: [], edited: [] })
  })

  it('an open pull request in a repository that declares no code matrix is neither read nor edited', () => {
    const dir = root(`${JSON.stringify({ harness: { command: 'pnpm run quality' }, shift: { prepush: ['pnpm run quality'] } })}\n`)
    const calls = noCalls()

    const code = runTreePr(['951', dir, reportFile(dir, REPORT_WITHOUT_LINE)], ports(SRC_WITH_CHANGESET, 901, calls), () => {})

    expect({ code, calls }).toEqual({ code: 0, calls: noCalls() })
  })

  it('tree-pr with no report argument takes the count line from the tree report', () => {
    const dir = root()
    mkdirSync(path.dirname(treeReportPath(dir)), { recursive: true })
    writeFileSync(treeReportPath(dir), REPORT_WITH_LINE)
    const calls = noCalls()
    const lines: string[] = []

    const code = runTreePr(['951', dir], ports(SRC_WITH_CHANGESET, null, calls), line => lines.push(line))

    expect({ code, lines, tails: calls.created.map(body => body.endsWith(`\n\n${COUNT_LINE}`)) }).toEqual({ code: 0, lines: [`${PREFIX}card #951: PR #901`], tails: [true] })
  })

  it('a scripts-only change opens its pull request with no count line and no gh pr edit', () => {
    const cases = { 'a new pull request': null, 'an open pull request': 901 }
    const observed = Object.fromEntries(Object.entries(cases).map(([name, open]) => {
      const dir = root()
      const calls = noCalls()
      const lines: string[] = []

      const code = runTreePr(['951', dir, reportFile(dir, REPORT_WITHOUT_LINE)], ports([{ status: 'M', path: 'scripts/shift/x.ts' }], open, calls), line => lines.push(line))

      return [name, { code, lines, edited: calls.edited, countLine: calls.created.some(body => body.includes('■')) }]
    }))

    expect(observed).toEqual(Object.fromEntries(Object.keys(cases).map(name => [name, { code: 0, lines: [`${PREFIX}card #951: PR #901`], edited: [], countLine: false }])))
  })
})
