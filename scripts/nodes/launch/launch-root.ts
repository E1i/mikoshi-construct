import type { DatabaseSync } from 'node:sqlite'
import type { ShiftTask } from '../../../src/card/task-file.js'
import type { DetectionMode } from '../../core/node.js'
import type { CardBodyReader } from '../../intake/parking-reads.js'
import type { LadderSteps } from '../../ladder/ladder-starter.js'
import type { IsolationReader } from '../../ports/isolation.js'
import type { TreePreparer } from '../../ports/prepare-tree.js'
import type { TreeOrigin } from '../../ports/worktree.js'
import type { CardStarter, StartedCard } from './launch-executor.js'
import type { SessionContinuer, StarterPlaces, StarterPorts } from './launch-starter.js'
import type { SessionStart } from './launch-worker.js'
import type { TreeFile } from './session-journal.js'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { parseParkingFile } from '../../../src/card/parking.js'
import { busPathOf, machineBusPath } from '../../core/bus-path.js'
import { busCardDecisions, withCardDecisions } from '../../core/card-decisions.js'
import { BUSY_TIMEOUT_MS, defaultBusPath, openBus } from '../../core/db.js'
import { messageOf } from '../../core/errors.js'
import { CARD_ANSWERED, CARD_CONTINUED, CARD_STARTED } from '../../core/events.js'
import { FACTORY_RUNTIME } from '../../core/factory-paths.js'
import { HANDOFF_DIR_VARIABLE, handoffDirOf } from '../../core/handoff-dir.js'
import { ghostLinesText } from '../../core/journal.js'
import { prefixOf, runNode } from '../../core/node.js'
import { eddiesJournalPath, reportPath } from '../../core/places.js'
import { openDatabase } from '../../core/sqlite.js'
import { busCardBodies } from '../../intake/parking-reads.js'
import { LadderCardStarter } from '../../ladder/ladder-starter.js'
import { briefBody, briefPathOf, ladderStep, reviewBody, tasksFilePathOf, tasksFileText } from '../../ladder/ladder.js'
import { reviewOf } from '../../ladder/verdict.js'
import { cardDecisionLines } from '../../policy/shards.js'
import { cardIsolationCommand, clientLastSteps, clientTranscript } from '../../ports/client/claude/adapter.js'
import { loadedCodeSha, processGit } from '../../ports/git.js'
import { realIsolationReader } from '../../ports/isolation.js'
import { prepareBeforeSession, prepareTree } from '../../ports/prepare-tree.js'
import { promptsDirOf } from '../../ports/prompt-store.js'
import { cardSessionOverlay, cardSizeIn, clientCommand, EXIT_REQUEST_VARIABLE, LOOP_PID_VARIABLE, sessionEnv, WINDOW_VARIABLE } from '../../ports/session.js'
import { CARD_SESSION_SANDBOX } from '../../ports/shift-settings.js'
import { builtTreePr, HTTPS_ORIGIN_ENV, launchDirOf, TREE_PR_ENTRY, treeHoldsACommit, treePrCommand, treePrPublisher } from '../../ports/tree-publish.js'
import { cardTree } from '../../ports/worktree-home.js'
import { treeOriginIn } from '../../ports/worktree.js'
import { BUILD_DIR, BUILT_MODULE, builtEntryOf, installedPackage } from '../../supervisor/bg.js'
import { launchSessionEnv, nodeLiveness, nodeSupply } from '../../supervisor/composition.js'
import { stampLogOutput } from '../../supervisor/stamp.js'
import { builtHandoff, continuationRefusal, CONTINUE_PROMPT, eddiesEvidence, reachedContextLine, sessionWrittenPart, stoppedOnSpend } from './continuation.js'
import { gitChangedPaths, killQuietly, psPgid, ShiftCardStarter, spawnDetached } from './launch-starter.js'
import { LEGACY_REASON, WITHDRAW_LEGACY_FLAG, withdrawLegacyLaunchTasks } from './launch-withdraw.js'
import { LaunchNode } from './launch-worker.js'
import { renderPrompt } from './prompt.js'
import { collectReport, missingReportDetail, recordedExitCode } from './report-collect.js'

export const PREFIX = prefixOf('launch')

const TASK_START_SCRIPT = 'task:start'
export const HEADER_FILE = path.join(import.meta.dirname, '..', '..', '..', FACTORY_RUNTIME.shiftHeader)

export function publishedTreePr(repo: string, installed: string | null): string {
  if (installed === null)
    return treePrCommand(repo)
  return builtTreePr(path.join(installed, BUILD_DIR, `${TREE_PR_ENTRY}${BUILT_MODULE}`))
}

export function taskStartCommand(installed: string | null): { file: string, args: string[] } {
  if (installed === null)
    return { file: 'pnpm', args: ['--silent', TASK_START_SCRIPT] }
  return { file: process.execPath, args: [builtEntryOf(installed, TASK_START_SCRIPT)] }
}

export function launchPlaces(home: string, repo: string, busPath: string = machineBusPath(home), installed: string | null = installedPackage()): StarterPlaces {
  return {
    launchDir: launchDirOf(home, busPath),
    treePr: publishedTreePr(repo, installed),
  }
}

export interface LaunchRun {
  busPath: string
  starter: CardStarter
  ladder?: CardStarter
  continuer?: SessionContinuer
  session: string
  pause: (ms: number) => Promise<unknown>
  isolation: IsolationReader
  launchDir: string
  treePr?: string
  treeOrigin?: (worktree: string) => TreeOrigin | null
}

export function runWithdrawLegacy(busPath: string, clock: () => Date): number {
  const db = openBus(busPath)
  try {
    const keys = withdrawLegacyLaunchTasks(db, clock().toISOString())
    for (const key of keys)
      console.log(`${PREFIX}${key}: withdrawn (${LEGACY_REASON}); nothing started`)
    console.log(`${PREFIX}${keys.length} withdrawn`)
    return 0
  }
  finally {
    db.close()
  }
}

export function hasCommitsAhead(card: StartedCard): boolean {
  try {
    return Number(processGit.read(card.worktree, ['rev-list', '--count', `${card.base}..HEAD`]).trim()) > 0
  }
  catch {
    return true
  }
}

export function reportWrittenSince(launchDir: string, start: SessionStart): boolean {
  const since = Date.parse(start.ts)
  return [`report-${start.cardId}.md`, `report-${start.cardId}-brief.md`].some((file) => {
    const report = path.join(launchDir, file)
    return existsSync(report) && statSync(report).mtimeMs >= since
  })
}

export function sessionLeftAResult(launchDir: string): (card: StartedCard, start: SessionStart) => boolean {
  return (card, start) => reportWrittenSince(launchDir, start) || hasCommitsAhead(card)
}

export function handoffWrittenSince(launchDir: string): (start: SessionStart) => boolean {
  return (start) => {
    const report = path.join(launchDir, `report-${start.cardId}.md`)
    return existsSync(report) && statSync(report).mtimeMs >= Date.parse(start.ts) && continuationRefusal(readFileSync(report, 'utf8')) === null
  }
}

const TREE_DIFF_MAX_BUFFER = 64 * 1024 * 1024

function treeDiffOf(card: StartedCard): string {
  try {
    const changed = gitChangedPaths(card.worktree).join('\n')
    const diff = processGit.readBytes(card.worktree, ['diff', card.base], TREE_DIFF_MAX_BUFFER).toString('utf8')
    return `${changed}\n\n${diff}`
  }
  catch (error) {
    return `the tree diff cannot be read: ${messageOf(error)}`
  }
}

export function handoffBuilder(launchDir: string): (card: StartedCard, start: SessionStart, body: string | null) => void {
  return (card, start, body) => {
    const saved = reportPath(launchDir, String(start.cardId))
    const report = existsSync(saved) ? readFileSync(saved, 'utf8') : null
    mkdirSync(path.dirname(saved), { recursive: true })
    writeFileSync(saved, builtHandoff({ cardId: start.cardId, session: card.session, report, diff: treeDiffOf(card), body, steps: clientLastSteps(process.env, card.worktree, card.session) }))
  }
}

export function reportSince(launchDir: string): (start: SessionStart) => string | null {
  return (start) => {
    const report = reportPath(launchDir, String(start.cardId))
    return reportWrittenSince(launchDir, start) && existsSync(report) ? readFileSync(report, 'utf8') : null
  }
}

export function reportCollector(launchDir: string): (card: StartedCard, start: SessionStart) => string | null {
  return (card, start) => {
    const collection = collectReport(card.worktree, reportPath(launchDir, String(start.cardId)))
    if (collection.kind === 'collected' || (collection.kind === 'absent' && reportWrittenSince(launchDir, start)))
      return null
    return missingReportDetail(start.cardId, collection, recordedExitCode(launchDir, start.cardId, Date.parse(start.ts)))
  }
}

export function eddiesWarned(card: StartedCard): boolean {
  const journal = eddiesJournalPath(card.worktree)
  return existsSync(journal) && eddiesEvidence(readFileSync(journal, 'utf8'), card.session).warned
}

function startedCardPublisher(treePr: string, launchDir: string, env: NodeJS.ProcessEnv): (card: StartedCard, start: SessionStart) => void {
  const publish = treePrPublisher(treePr, launchDir, env)
  return (card, start) => publish(card.worktree, start.cardId)
}

export function reportResultLine(launchDir: string): (start: SessionStart) => string | null {
  return (start) => {
    const report = path.join(launchDir, `report-${start.cardId}.md`)
    if (!reportWrittenSince(launchDir, start) || !existsSync(report))
      return null
    return readFileSync(report, 'utf8').split('\n').find(line => line.startsWith('result: ')) ?? null
  }
}

export async function runLaunchWorker(argv: string[], run: LaunchRun): Promise<number> {
  if (argv.includes(WITHDRAW_LEGACY_FLAG))
    return runWithdrawLegacy(run.busPath, () => new Date())
  let node: LaunchNode | undefined
  const build = (db: DatabaseSync, mode: DetectionMode): LaunchNode => {
    node = new LaunchNode({ ...nodeLiveness(), db, starter: run.starter, ladder: run.ladder, clock: () => new Date(), session: run.session, mode, env: process.env, isolation: run.isolation, resulted: sessionLeftAResult(run.launchDir), endedWith: reportResultLine(run.launchDir), handedOff: handoffWrittenSince(run.launchDir), reportOf: reportSince(run.launchDir), collected: reportCollector(run.launchDir), warned: eddiesWarned, atContextLine: card => reachedContextLine(card.worktree, card.session), spendStopped: card => stoppedOnSpend(card.worktree, card.session), buildHandoff: handoffBuilder(run.launchDir), ...(run.treePr === undefined ? {} : { publish: startedCardPublisher(run.treePr, run.launchDir, process.env), committed: (card: StartedCard) => treeHoldsACommit(card.worktree, card.base) }), continuer: run.continuer, prompts: promptsDirOf(run.busPath), ...(run.treeOrigin === undefined ? {} : { treeOrigin: run.treeOrigin }) })
    return node
  }
  const pause = async (ms: number): Promise<unknown> => {
    node?.stopOverdue()
    return run.pause(ms)
  }
  return runNode(argv, 'launch', run.busPath, build, { pause, codeSha: loadedCodeSha, supply: nodeSupply() })
}

export const CARD_TEXT_HEADING = 'The card text this session runs on:'

export function continuedOnCardText(task: ShiftTask, bodyOf: CardBodyReader): ShiftTask {
  if (!task.body.startsWith(CONTINUE_PROMPT))
    return task
  const text = bodyOf(task.card.id)
  const parsed = text === null ? null : parseParkingFile(`${task.card.id}.md`, text)
  if (parsed?.kind !== 'parked')
    return task
  return { ...task, body: `${task.body}\n\n${CARD_TEXT_HEADING}\n\n${parsed.parked.task.body}` }
}

export class CutTreeOrigins {
  private readonly byTree = new Map<string, TreeOrigin>()

  note(worktree: string, taskStartOutput: string): void {
    const origin = treeOriginIn(taskStartOutput)
    if (origin !== null)
      this.byTree.set(worktree, origin)
  }

  readonly take = (worktree: string): TreeOrigin | null => {
    const origin = this.byTree.get(worktree) ?? null
    this.byTree.delete(worktree)
    return origin
  }
}

export function realStarterPorts(repo: string, env: NodeJS.ProcessEnv, header: string, uuid: () => string, bodyOf: CardBodyReader = () => null, cardSessions: (cardId: number) => string[] = () => [], installed: string | null = installedPackage(), busPath: string = busPathOf(env, os.homedir(), repo), prepare: TreePreparer = prepareTree, origins: CutTreeOrigins = new CutTreeOrigins(), decisionsOf: (cardId: number) => string[] = () => []): StarterPorts {
  const taskStart = taskStartCommand(installed)
  return {
    read: bodyOf,
    cut: (task) => {
      const output = execFileSync(taskStart.file, [...taskStart.args, task.branch, '--card', task.card.line], { cwd: repo, env: { ...env, [WINDOW_VARIABLE]: '', [LOOP_PID_VARIABLE]: '', [EXIT_REQUEST_VARIABLE]: '' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
      const worktree = cardTree(env, busPath, String(task.card.id))
      origins.note(worktree, output)
      return worktree
    },
    base: worktree => processGit.read(worktree, ['rev-parse', 'HEAD']).trim(),
    spawnDetached: (detached) => {
      const unprepared = prepareBeforeSession(detached.cwd, prepare)
      if (unprepared !== null)
        console.error(`${PREFIX}card session in ${detached.cwd}: ${unprepared}`)
      return spawnDetached(detached)
    },
    pgidOf: psPgid,
    kill: killQuietly,
    uuid,
    envOf: cardId => ({ ...sessionEnv(env, cardId, cardSessionOverlay(repo, env, cardSizeIn(bodyOf(cardId)))), ...launchSessionEnv(cardId), ...HTTPS_ORIGIN_ENV }),
    prompt: (task, places) => renderPrompt(header, withCardDecisions(continuedOnCardText(task, bodyOf), decisionsOf(task.card.id)), places),
    changedPaths: gitChangedPaths,
    readReport: file => existsSync(file) ? sessionWrittenPart(readFileSync(file, 'utf8')) : null,
    cardSessions,
    readTranscript: (worktree, session) => clientTranscript(env, worktree, session),
    treeFile: readTreeFile,
  }
}

export function readTreeFile(file: string): TreeFile | null {
  try {
    return { content: readFileSync(file, 'utf8'), mtimeMs: statSync(file).mtimeMs }
  }
  catch {
    return null
  }
}

const CARD_SESSIONS = `
  SELECT json_extract(payload, '$.session') AS session FROM events
  WHERE legacy = 0 AND type IN ('${CARD_STARTED}', '${CARD_CONTINUED}', '${CARD_ANSWERED}') AND card_id = ? AND json_valid(payload) AND json_type(payload, '$.session') = 'text'
  ORDER BY id
`

export function cardSessionsIn(db: DatabaseSync, cardId: number): string[] {
  return (db.prepare(CARD_SESSIONS).all(cardId) as { session: string }[]).map(row => row.session)
}

export function busCardSessions(busPath: string): (cardId: number) => string[] {
  return (cardId) => {
    if (!existsSync(busPath))
      return []
    const db = openDatabase(busPath, { readOnly: true, timeout: BUSY_TIMEOUT_MS })
    try {
      return [...new Set(cardSessionsIn(db, cardId))]
    }
    finally {
      db.close()
    }
  }
}

export function busStarterPorts(busPath: string, repo: string, env: NodeJS.ProcessEnv, header: string, uuid: () => string, origins?: CutTreeOrigins): StarterPorts {
  return realStarterPorts(repo, env, header, uuid, busCardBodies(busPath), busCardSessions(busPath), installedPackage(), busPath, prepareTree, origins, busCardDecisions(busPath, cardDecisionLines))
}

export function repoHandoffEnv(env: NodeJS.ProcessEnv, repo: string, home: string = os.homedir()): NodeJS.ProcessEnv {
  return { ...env, [HANDOFF_DIR_VARIABLE]: handoffDirOf(env, home, repo) }
}

export function repoLadderSteps(repo: string, env: NodeJS.ProcessEnv, busPath: string, home: string = os.homedir()): LadderSteps {
  return handoffLadderSteps(handoffDirOf(env, home, repo), repo, env, busPath)
}

export function handoffLadderSteps(handoffDir: string, repo: string, env: NodeJS.ProcessEnv, busPath: string): LadderSteps {
  const readIfThere = (file: string): string | null => existsSync(file) ? readFileSync(file, 'utf8') : null
  return {
    stepOf: task => ladderStep({ journal: ghostLinesText(busPath), brief: readIfThere(briefPathOf(handoffDir, task.card)) }, task.card),
    tree: (task) => {
      const tree = cardTree(env, busPath, String(task.card.id))
      return existsSync(tree) ? tree : null
    },
    brief: task => briefPathOf(handoffDir, task.card),
    tasksFile: (task) => {
      const file = tasksFilePathOf(handoffDir, task.card)
      const text = tasksFileText(task.card, { repo, handoffDir, brief: briefPathOf(handoffDir, task.card) })
      if (existsSync(file)) {
        if (readFileSync(file, 'utf8') !== text)
          throw new Error(`${file} exists and holds another tasks file; nothing launched`)
        return file
      }
      mkdirSync(handoffDir, { recursive: true })
      writeFileSync(file, text)
      return file
    },
    body: (task, step) => {
      const brief = briefPathOf(handoffDir, task.card)
      return step === 'brief' ? briefBody(task.card, brief) : reviewBody(task.card, brief, reviewOf(task.touches))
    },
  }
}

export function launchIsolationCommand(claude: string): string[] {
  return cardIsolationCommand(claude)
}

async function main(): Promise<number> {
  const busPath = defaultBusPath()
  const env = repoHandoffEnv(process.env, process.cwd())
  const places = launchPlaces(os.homedir(), process.cwd(), busPath)
  const header = readFileSync(HEADER_FILE, 'utf8')
  const origins = new CutTreeOrigins()
  const ports = busStarterPorts(busPath, process.cwd(), env, header, randomUUID, origins)
  const starter = new ShiftCardStarter(places, ports)
  const ladder = new LadderCardStarter({ ...places, repo: process.cwd() }, ports, repoLadderSteps(process.cwd(), env, busPath))
  return runLaunchWorker(process.argv.slice(2), { busPath, starter, ladder, continuer: starter, session: randomUUID(), pause: sleep, launchDir: places.launchDir, treePr: places.treePr, treeOrigin: origins.take, isolation: realIsolationReader(env, process.cwd(), launchIsolationCommand(clientCommand()), { sandbox: CARD_SESSION_SANDBOX }) })
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  stampLogOutput()
  process.exitCode = await main()
}
