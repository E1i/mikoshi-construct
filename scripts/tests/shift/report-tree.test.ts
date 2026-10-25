import type { CardStart, CardStarter, QueuedCard, StartedCard } from '../../nodes/launch/launch-executor.js'
import type { TreePrPorts } from '../../nodes/launch/tree-pr.js'
import type { ProcessTable } from '../../nodes/restart/chain-process.js'
import type { IsolationReader } from '../../ports/isolation.js'
import type { MergeBench } from '../bus/merge-bench.js'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { parkingFileText } from '../../../src/card/parking.js'
import { appendEvent, openBus } from '../../core/db.js'
import { CARD_ADMITTED, CARD_STARTED, CARD_STOPPED } from '../../core/events.js'
import { exitCodePath, reportPath, treeReportPath } from '../../core/places.js'
import { launchArgv } from '../../nodes/launch/launch-starter.js'
import { LaunchNode, reportCollector, reportSince } from '../../nodes/launch/launch-worker.js'
import { collectReport, REPORT_MISSING, restoreReport } from '../../nodes/launch/report-collect.js'
import { busCardReturned, busCardStopped, busCardWaited, busLastRefusal, busPrOpened, runTreePr } from '../../nodes/launch/tree-pr-cli.js'
import { eventsOf, mergeBench } from '../bus/merge-bench.js'

const CARD = 951
const OPENED_PR = 954
const REPORT_TEXT = `#${CARD} x\nresult: done\nPR #${OPENED_PR}\nverification: run\nfinding: F-a-fixture-finding the fixture saw\nquestion: may the fixture keep x?\n`
const sandboxed: IsolationReader = () => ({ level: 'full', mechanism: 'claude-code-sandbox', gaps: [] })

const roots: string[] = []
const benches: MergeBench[] = []

afterEach(() => {
  for (const made of benches.splice(0))
    made.close()
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

interface CardTree {
  root: string
  worktree: string
  launchDir: string
}

function cardTree(): CardTree {
  const root = mkdtempSync(path.join(tmpdir(), 'report-tree-'))
  roots.push(root)
  const origin = path.join(root, 'origin.git')
  const worktree = path.join(root, 'tree')
  const launchDir = path.join(root, 'launch')
  mkdirSync(launchDir)
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', origin])
  execFileSync('git', ['init', '-q', '-b', 'main', worktree])
  git(worktree, ['config', 'user.email', 'shift@example.com'])
  git(worktree, ['config', 'user.name', 'shift'])
  git(worktree, ['config', 'commit.gpgsign', 'false'])
  mkdirSync(path.join(worktree, 'docs'))
  writeFileSync(path.join(worktree, 'docs', 'x.md'), 'base\n')
  git(worktree, ['add', '-A'])
  git(worktree, ['commit', '-q', '-m', 'base'])
  git(worktree, ['remote', 'add', 'origin', origin])
  git(worktree, ['push', '-q', 'origin', 'main'])
  git(worktree, ['fetch', '-q', 'origin'])
  git(worktree, ['checkout', '-q', '-b', 'feat/x'])
  return { root, worktree, launchDir }
}

function session(tree: CardTree, script: string): { code: number | null, treePrRan: boolean, exit: string } {
  const marker = path.join(tree.root, 'tree-pr-ran')
  writeFileSync(path.join(tree.root, 'fixture-report.md'), REPORT_TEXT)
  const args = launchArgv({ command: `sh -c '${script}' claude`, treePr: `sh -c 'touch "$0"' ${marker}`, cardId: CARD, worktree: tree.worktree, report: reportPath(tree.launchDir, String(CARD)), exit: exitCodePath(tree.launchDir, String(CARD)), id: 's-951' })
  const run = spawnSync('sh', args, { cwd: tree.worktree, encoding: 'utf8' })
  return { code: run.status, treePrRan: existsSync(marker), exit: readFileSync(exitCodePath(tree.launchDir, String(CARD)), 'utf8').trim() }
}

const WRITES_REPORT = 'mkdir -p .construct && cp ../fixture-report.md .construct/report.md && echo mine > docs/x.md'

function openingGh(): TreePrPorts['gh'] {
  return (args) => {
    if (args[1] === 'list')
      return '[]'
    if (args[1] === 'create')
      return `https://github.com/o/r/pull/${OPENED_PR}\n`
    throw new Error(`unexpected gh ${args.join(' ')}`)
  }
}

function treePrIn(tree: CardTree): { code: number, stops: { code?: string, detail?: string }[], opened: number[] } {
  const busPath = path.join(tree.root, 'bus.db')
  const db = openBus(busPath)
  appendEvent(db, { ts: '2026-10-22T04:00:00.000Z', type: CARD_STARTED, actor: 'worker:launch:1', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_STARTED}:launch:${CARD}:1`, payload: {}, legacy: false })
  db.close()
  const bus = { busPath, pid: 4242, now: () => new Date('2026-10-22T05:00:00.000Z'), err: () => {} }
  const card = parkingFileText({ card: `#${CARD} x [implement/netwatch/S/cheap/auto] · depends — · blocks —`, branch: 'feat/x', touches: ['docs/x.md'], continue: 'stop', who: 'shift', body: 'Do x.' })
  const code = runTreePr([String(CARD), tree.worktree, reportPath(tree.launchDir, String(CARD))], {
    card: cardId => cardId === CARD ? card : null,
    opened: busPrOpened(bus),
    stopped: busCardStopped(bus),
    waited: busCardWaited(bus),
    lastRefusal: busLastRefusal(busPath),
    returned: busCardReturned(bus),
    git,
    gh: openingGh(),
    resume: () => false,
    collect: collectReport,
  }, () => {})
  const read = openBus(busPath)
  const rows = read.prepare(`SELECT type, pr, payload FROM events WHERE card_id = ? AND type IN ('${CARD_STOPPED}', 'pr.opened') ORDER BY id`).all(CARD) as { type: string, pr: number | null, payload: string }[]
  read.close()
  return {
    code,
    stops: rows.filter(row => row.type === CARD_STOPPED).map(row => JSON.parse(row.payload) as { code?: string, detail?: string }),
    opened: rows.filter(row => row.type === 'pr.opened').map(row => row.pr!),
  }
}

describe('the shift report lives in the card tree and the bus collects it', () => {
  it('(a) a session that exits 0 records its exit code, the pull request opens with the report never committed and no .gitignore, and its finding and question lines are read from the bus after the tree is gone', () => {
    const tree = cardTree()

    const ran = session(tree, WRITES_REPORT)
    const pr = treePrIn(tree)

    const committed = git(tree.worktree, ['show', '--name-only', '--format=', 'origin/feat/x']).trim().split('\n')
    const gitignore = existsSync(path.join(tree.worktree, '.gitignore'))
    const inTree = existsSync(treeReportPath(tree.worktree))
    rmSync(tree.worktree, { recursive: true, force: true })
    const read = reportSince(tree.launchDir)({ cardId: CARD, ts: '2026-10-09T12:00:00.000Z' }) ?? ''
    expect({ ran, pr, committed, gitignore, inTree, saved: read, lines: read.split('\n').filter(line => /^(?:finding|question):/.test(line)) })
      .toEqual({ ran: { code: 0, treePrRan: true, exit: '0' }, pr: { code: 0, stops: [], opened: [OPENED_PR] }, committed: ['docs/x.md'], gitignore: false, inTree: false, saved: REPORT_TEXT, lines: ['finding: F-a-fixture-finding the fixture saw', 'question: may the fixture keep x?'] })
  })

  it('(b) a session that exits non-zero runs no tree-pr, records its code, and its report is still collected out of the tree', () => {
    const tree = cardTree()

    const ran = session(tree, `${WRITES_REPORT} && exit 3`)
    const missing = reportCollector(tree.launchDir)({ session: 's-951', worktree: tree.worktree, branch: 'feat/x', base: 'b'.repeat(40), pid: 1, pgid: 1, contour: 'cheap' }, { cardId: CARD, ts: '2026-10-09T12:00:00.000Z' })

    expect({ ran, missing, saved: readFileSync(reportPath(tree.launchDir, String(CARD)), 'utf8'), inTree: existsSync(treeReportPath(tree.worktree)), status: git(tree.worktree, ['status', '--porcelain']).trim() })
      .toEqual({ ran: { code: 3, treePrRan: false, exit: '3' }, missing: null, saved: REPORT_TEXT, inTree: false, status: 'M docs/x.md' })
  })

  it('(c) a cheap session that ended with no report gets card.stopped report-missing naming the tree path and its exit code', async () => {
    const tree = cardTree()
    session(tree, 'exit 5')
    const made = mergeBench()
    benches.push(made)
    appendEvent(made.db, { ts: made.clock.now().toISOString(), type: CARD_ADMITTED, actor: 'policy', cardId: CARD, pr: null, head: null, dedupeKey: `${CARD_ADMITTED}:${CARD}`, payload: { lane: 'lane-a', decision: 'auto', contour: 'cheap', depends: [], admission: `admission-${CARD}` }, legacy: false })
    made.tick()
    const starter: CardStarter = {
      start: (_card: QueuedCard): CardStart => ({ kind: 'started', card: { session: 's-951', worktree: tree.worktree, branch: 'feat/x', base: 'f'.repeat(40), pid: 4242, pgid: 4242 } }),
      stop: (_card: StartedCard) => {},
    }
    const processes: ProcessTable = { commandLine: () => null, signalGroup: () => {} }
    const node = new LaunchNode({ db: made.db, starter, clock: made.clock.now, session: 'node-1', mode: 'live', env: {}, processes, resulted: () => true, collected: reportCollector(tree.launchDir), isolation: sandboxed })
    const controller = new AbortController()

    await node.run({ pause: async () => controller.abort(), signal: controller.signal })
    made.tick()
    node.stopOverdue()

    expect(eventsOf(made.db, CARD_STOPPED)).toEqual([{ reason: 'fault', code: REPORT_MISSING, detail: `${REPORT_MISSING}: card #${CARD}: the shift report ${treeReportPath(tree.worktree)}: no report was written there; the session exited with code 5` }])
  })

  it('(d) tree-pr with no report in the tree refuses with report-missing and opens no pull request', () => {
    const tree = cardTree()
    writeFileSync(path.join(tree.worktree, 'docs', 'x.md'), 'mine\n')

    const pr = treePrIn(tree)

    expect({ code: pr.code, opened: pr.opened, codes: pr.stops.map(stop => stop.code), names: pr.stops[0]?.detail?.includes(treeReportPath(tree.worktree)), pushed: git(tree.worktree, ['ls-remote', 'origin', 'feat/x']).trim() })
      .toEqual({ code: 1, opened: [], codes: [REPORT_MISSING], names: true, pushed: '' })
  })

  it('(e) an empty report is unreadable, and a continuation restores the saved report into the tree', () => {
    const tree = cardTree()
    mkdirSync(path.dirname(treeReportPath(tree.worktree)), { recursive: true })
    writeFileSync(treeReportPath(tree.worktree), '  \n')
    const saved = reportPath(tree.launchDir, String(CARD))

    const empty = collectReport(tree.worktree, saved)
    writeFileSync(saved, REPORT_TEXT)
    restoreReport(saved, tree.worktree)

    expect({ empty, restored: readFileSync(treeReportPath(tree.worktree), 'utf8') }).toEqual({ empty: { kind: 'unreadable', tree: treeReportPath(tree.worktree), reason: 'the file is empty' }, restored: REPORT_TEXT })
  })
})
