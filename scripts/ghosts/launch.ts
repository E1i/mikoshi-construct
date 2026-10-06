import type { Signal, SignalStyle } from '../../src/ui/signal.js'
import type { Expect } from './expect.js'
import type { RangeDiffOutcome } from './journal.js'
import type { Sketch } from './sketch.js'
import type { FallKind, PreparedTask, SupervisorPayload, TaskContext, TaskOutcome } from './supervise.js'
import type { StartedTree, Task } from './tasks.js'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { createInterface } from 'node:readline'
import { renderSignal, terminalStyle } from '../../src/ui/signal.js'
import { approvedHashPath, approverOf, cardNumberOf, checkApproval, fallsOf, journalEvents, MORSE, morseApprovalOf, revocationOf, revokeEvent, sha256Hex } from './approval.js'
import { ENTRY_RESULT, entryEvent } from './entry.js'
import { launchStepExpects } from './expect-sample.js'
import { briefEffort, formatExpect, formatStepBreakdown, parseExpect } from './expect.js'
import { appendJournalEvent } from './journal.js'
import { lookupMatrixRow } from './matrix.js'
import { REGENERATED_PATHS } from './regenerated.js'
import { describeSketch, parseSketch, rangeDiffVerdict } from './sketch.js'
import { ghostRowState } from './status.js'
import { errorMessage, FALL_KINDS, fallEvent, git, resultPathOf, spawnSupervisor } from './supervise.js'
import { readTasksFile, startedTree } from './tasks.js'

function branchExists(repo: string, branch: string): boolean {
  try {
    execFileSync('git', ['-C', repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { stdio: 'pipe' })
    return true
  }
  catch {
    return false
  }
}

interface SketchCheck { refusals: string[], rangeDiff: RangeDiffOutcome | null, regenerated: string[] }

function sketchRefusals(repo: string, taskId: string, baseSha: string, sketch: Sketch, approvedSketch: string): SketchCheck {
  const refused = (reason: string): SketchCheck => ({ refusals: [`task ${taskId}: ${reason}`], rangeDiff: null, regenerated: [] })
  if (sketch.kind === 'none') {
    return approvedSketch === 'none'
      ? { refusals: [], rangeDiff: null, regenerated: [] }
      : refused(`the approval names sketch ${approvedSketch.slice(0, 7)} and the brief says Sketch: none; re-approve the brief`)
  }
  if (approvedSketch === 'none')
    return refused(`the approval names Sketch: none and the brief names ${sketch.branch} @ ${sketch.sha.slice(0, 7)}; re-approve the brief`)
  if (!branchExists(repo, sketch.branch))
    return refused(`sketch branch ${sketch.branch} does not exist in ${repo}`)
  const tip = git(repo, ['rev-parse', `refs/heads/${sketch.branch}`])
  if (tip !== sketch.sha)
    return refused(`sketch branch ${sketch.branch} is at ${tip}, not the ${sketch.sha} the brief names`)
  try {
    execFileSync('git', ['-C', repo, 'merge-base', '--is-ancestor', baseSha, sketch.sha], { stdio: 'pipe' })
  }
  catch {
    return refused(`sketch ${sketch.sha.slice(0, 7)} does not contain origin/main ${baseSha.slice(0, 7)}; rebase ${sketch.branch} onto origin/main and re-approve the brief`)
  }
  if (approvedSketch === sketch.sha)
    return { refusals: [], rangeDiff: 'identical', regenerated: [] }
  const verdict = rangeDiffVerdict(args => git(repo, args), approvedSketch, sketch.sha, baseSha, REGENERATED_PATHS)
  if (!verdict.ok)
    return refused(verdict.reason)
  const regenerated = verdict.regenerated ?? []
  return { refusals: [], rangeDiff: regenerated.length === 0 ? 'equal' : 'regenerated', regenerated }
}

function isAncestor(repo: string, ancestor: string, descendant: string): boolean {
  try {
    execFileSync('git', ['-C', repo, 'merge-base', '--is-ancestor', ancestor, descendant], { stdio: 'pipe' })
    return true
  }
  catch {
    return false
  }
}

function changedPathCount(worktree: string): number {
  return git(worktree, ['status', '--porcelain']).split('\n').filter(line => line !== '').length
}

function treeRefusal(task: Task, tree: StartedTree | undefined, journalPath: string, startSha: string | undefined, baseSha: string): string | undefined {
  const card = `card #${task.card.id}`
  if (tree === undefined)
    return `${card} has no task:start line in ${journalPath}; start it with pnpm task:start <branch> --card "${task.card.line}" before a Ghost runs on it`
  const cut = `the tree ${tree.worktree} that task:start cut for ${card}`
  if (!existsSync(tree.worktree))
    return `${cut} does not exist`
  const branch = git(tree.worktree, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (branch !== tree.branch)
    return `${cut} is on ${branch}, not on ${tree.branch}`
  const changed = changedPathCount(tree.worktree)
  if (changed > 0)
    return `${cut} has ${changed} changed paths; commit or reset them before a Ghost runs there`
  if (startSha !== undefined && !isAncestor(tree.worktree, 'HEAD', startSha))
    return `${tree.branch} in ${tree.worktree} carries commits that neither origin/main ${baseSha.slice(0, 7)} nor the sketch holds, and the Ghost would drop them`
  return undefined
}

const USAGE = 'usage: launch.ts --tasks <file> [--owner-allows <card>]... | launch.ts --tasks <file> --fall <kind> --card <card> | launch.ts --tasks <file> --revoke <sha256> --card <card>'

const FALLS_BEFORE_CUT = 2

interface LaunchArgs {
  tasksFile: string
  ownerAllows: number[]
  fall: { kind: FallKind, card: number } | null
  revoke: { sha256: string, card: number } | null
}

function flagValues(argv: string[], flag: string): string[] {
  return argv.flatMap((arg, index) => {
    if (arg !== flag)
      return []
    if (index === argv.length - 1)
      throw new Error(USAGE)
    return [argv[index + 1]]
  })
}

function cardNumber(value: string): number {
  const card = cardNumberOf(value)
  if (card === undefined)
    throw new Error(`${USAGE}\ncard: expected a card number, got '${value}'`)
  return card
}

function revokedSha256(value: string): string {
  if (!/^[0-9a-f]{64}$/.test(value))
    throw new Error(`${USAGE}\nrevoke: expected a 64-character sha256, got '${value}'`)
  return value
}

function fallKind(value: string): FallKind {
  const kind = FALL_KINDS.find(known => known === value)
  if (kind === undefined)
    throw new Error(`${USAGE}\nfall: expected one of ${FALL_KINDS.join(', ')}, got '${value}'`)
  return kind
}

function parseArgs(argv: string[]): LaunchArgs {
  const [tasksFile] = flagValues(argv, '--tasks')
  if (tasksFile === undefined)
    throw new Error(USAGE)
  const ownerAllows = flagValues(argv, '--owner-allows').map(cardNumber)
  const [kind] = flagValues(argv, '--fall')
  const [revoke] = flagValues(argv, '--revoke')
  const [card] = flagValues(argv, '--card')
  const markers = [kind, revoke].filter(value => value !== undefined).length
  if (markers > 1 || (markers === 1) !== (card !== undefined) || (markers === 1 && ownerAllows.length > 0))
    throw new Error(USAGE)
  return {
    tasksFile,
    ownerAllows,
    fall: kind === undefined ? null : { kind: fallKind(kind), card: cardNumber(card) },
    revoke: revoke === undefined ? null : { sha256: revokedSha256(revoke), card: cardNumber(card) },
  }
}

function twoFallsRefusals(journalPath: string, tasks: Task[], ownerAllows: number[]): string[] {
  const events = journalEvents(journalPath)
  return tasks.flatMap((task) => {
    if (ownerAllows.includes(task.card.id))
      return []
    const falls = fallsOf(events, task.card.id)
    return falls.length < FALLS_BEFORE_CUT
      ? []
      : [`task ${task.id}: card #${task.card.id} fell ${falls.length} times (${falls.join(', ')}); cut the task into sub-cards with construct intake instead of a third Ghost, or relaunch with --owner-allows ${task.card.id} on the owner's explicit decision`]
  })
}

function readLine(): Promise<string | undefined> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin })
    let answered = false
    rl.on('line', (line) => {
      if (!answered) {
        answered = true
        rl.close()
        resolve(line)
      }
    })
    rl.on('close', () => {
      if (!answered)
        resolve(undefined)
    })
  })
}

function tasksFileRefusals(out: string, matrixPath: string | undefined, tasks: Task[]): string[] {
  const refusals: string[] = []
  if (!path.isAbsolute(out))
    refusals.push(`tasks file field out: expected an absolute path, got '${out}'`)
  try {
    for (const task of tasks)
      lookupMatrixRow(matrixPath, task.id)
  }
  catch (error) {
    refusals.push(`matrix ${matrixPath}: ${errorMessage(error)}`)
  }
  return refusals
}

async function prepareAndPreflight(repo: string, statusPath: string, out: string, matrixPath: string | undefined, tasks: Task[], ownerAllows: number[]): Promise<{ baseSha: string, prepared: PreparedTask[], byMorse: ReadonlySet<string>, refusals: string[] }> {
  const refusals = [...tasksFileRefusals(out, matrixPath, tasks), ...twoFallsRefusals(journalPathOf(out), tasks, ownerAllows)]

  git(repo, ['fetch', 'origin', 'main'])
  const baseSha = git(repo, ['rev-parse', 'origin/main'])

  const statusText = existsSync(statusPath) ? await readFile(statusPath, 'utf8') : undefined
  const journalPath = journalPathOf(out)
  const journalText = existsSync(journalPath) ? await readFile(journalPath, 'utf8') : ''
  const prepared: PreparedTask[] = []
  const byMorse = new Set<string>()
  const events = journalEvents(journalPath)

  for (const task of tasks) {
    const approval = checkApproval(task.brief)
    if (!approval.ok) {
      refusals.push(`task ${task.id}: ${approval.reason}`)
      continue
    }

    const revoked = revocationOf(events, approval.sha256, task.card.id)
    if (revoked !== undefined) {
      refusals.push(`task ${task.id}: the approval ${approval.sha256} of card #${task.card.id} was revoked${typeof revoked.ts === 'string' ? ` at ${revoked.ts}` : ''}; re-approve the brief by changing its text`)
      continue
    }
    if (approverOf(readFileSync(approvedHashPath(task.brief), 'utf8'))?.toLowerCase() === MORSE) {
      if (morseApprovalOf(events, approval.sha256, task.card.id) === undefined) {
        refusals.push(`task ${task.id}: ${path.basename(approvedHashPath(task.brief))} is signed ${MORSE} and ${journalPath} holds no approval event by ${MORSE} for card #${task.card.id} and ${approval.sha256}`)
        continue
      }
      byMorse.add(task.id)
    }

    let sketch: Sketch
    try {
      sketch = parseSketch(approval.text)
    }
    catch (error) {
      refusals.push(`task ${task.id}: ${task.brief}: ${errorMessage(error)}`)
      continue
    }
    const sketchCheck = sketchRefusals(repo, task.id, baseSha, sketch, approval.approvedSketch)
    refusals.push(...sketchCheck.refusals)

    let expected: Expect | null
    try {
      expected = parseExpect(approval.text)
    }
    catch (error) {
      refusals.push(`task ${task.id}: ${task.brief}: ${errorMessage(error)}`)
      continue
    }

    const tree = startedTree(journalText, task.card)
    const startSha = sketchCheck.refusals.length > 0 ? undefined : sketch.kind === 'branch' ? sketch.sha : baseSha
    const refusal = treeRefusal(task, tree, journalPath, startSha, baseSha)
    if (refusal !== undefined)
      refusals.push(`task ${task.id}: ${refusal}`)

    if (statusText !== undefined) {
      const state = ghostRowState(statusText, task.id)
      if (state === 'writing' || state === 'reviewing')
        refusals.push(`task ${task.id}: status.md row ghost-${task.id} is busy (state ${state})`)
    }

    const reportPath = path.join(out, `ghost-${task.id}.jsonl`)
    if (existsSync(reportPath))
      refusals.push(`task ${task.id}: report file ${reportPath} already exists`)

    if (tree === undefined)
      continue

    prepared.push({
      ...task,
      ...tree,
      approvedText: approval.text,
      approvedSha256: approval.sha256,
      approvedSketch: approval.approvedSketch,
      agreedSha256: sha256Hex(approval.text),
      rangeDiff: sketchCheck.rangeDiff,
      regenerated: sketchCheck.regenerated,
      sketch,
      expected,
      stepsExpected: launchStepExpects(repo, briefEffort(approval.text)),
      sessionId: randomUUID(),
      reportPath,
      stderrPath: path.join(out, `ghost-${task.id}.stderr`),
    })
  }

  return { baseSha, prepared, byMorse, refusals }
}

const ACCEPTANCE_LINE = /^Acceptance:/m

function describeSketchOf(task: PreparedTask): string {
  const described = describeSketch(task.sketch)
  if (task.rangeDiff === 'regenerated')
    return `${described}, approved ${task.approvedSketch.slice(0, 7)} with range-diff all = outside ${task.regenerated.join(', ')}, whose check runs in the worktree after install`
  return task.rangeDiff === 'equal' ? `${described}, approved ${task.approvedSketch.slice(0, 7)} with range-diff all =` : described
}

function signalOf(task: PreparedTask, baseSha: string, byMorse: ReadonlySet<string>): Signal {
  const approved = task.approvedSha256.slice(0, 7)
  const law = ACCEPTANCE_LINE.test(task.approvedText) ? 'law brief Acceptance:' : 'law not recorded in the brief'
  return {
    CONTRACT: `ladder · brief ${path.basename(task.brief)} approved ${approved}${byMorse.has(task.id) ? ` by ${MORSE}` : ''} · ${law}`,
    EXPECT: task.expected === null ? `expect not recorded in the brief${formatStepBreakdown(task.stepsExpected)}` : formatExpect(task.expected, task.stepsExpected),
    ACTION: `${task.id}: /implement ${task.brief} (approved ${approved}) -> ${task.worktree} on ${task.branch} @ ${baseSha.slice(0, 7)} ${describeSketchOf(task)}, report ${task.reportPath}, session ${task.sessionId}`,
    RESULT: ENTRY_RESULT,
  }
}

function launchEntryEvent(task: PreparedTask, baseSha: string, byMorse: ReadonlySet<string>): object {
  return { ...entryEvent(task.id, signalOf(task, baseSha, byMorse), new Date().toISOString()), card: task.card }
}

function describeTask(task: PreparedTask, baseSha: string, byMorse: ReadonlySet<string>, style: SignalStyle): string[] {
  return renderSignal(`ghosts:launch ${task.id}`, signalOf(task, baseSha, byMorse), style)
}

function journalPathOf(out: string): string {
  return path.join(out, 'ghosts.jsonl')
}

function ownerAllowsEvents(prepared: PreparedTask[], ownerAllows: number[]): object[] {
  const ts = new Date().toISOString()
  return ownerAllows.map(card => ({ event: 'owner-allows', card, tasks: prepared.filter(task => task.card.id === card).map(task => task.id), ts }))
}

async function superviseBatch(payload: SupervisorPayload): Promise<TaskOutcome[] | null> {
  const payloadPath = path.join(payload.ctx.out, `ghost-launch-${randomUUID()}.json`)
  const logPath = `${payloadPath.replace(/\.json$/, '')}.supervisor.log`
  writeFileSync(payloadPath, `${JSON.stringify(payload)}\n`)
  const code = await spawnSupervisor(payloadPath, logPath)
  const resultPath = resultPathOf(payloadPath)
  if (!existsSync(resultPath)) {
    console.error(`supervisor exit ${code}, no result; log ${logPath}`)
    process.exitCode = 1
    return null
  }
  return JSON.parse(readFileSync(resultPath, 'utf8')) as TaskOutcome[]
}

async function main(): Promise<void> {
  const { tasksFile, ownerAllows, fall, revoke } = parseArgs(process.argv.slice(2))
  const { repo, status, out, tasks, matrix } = readTasksFile(tasksFile)

  if (fall !== null) {
    await appendJournalEvent(journalPathOf(out), fallEvent(fall.card, fall.kind))
    console.log(`card #${fall.card}: fall ${fall.kind} recorded, ${fallsOf(journalEvents(journalPathOf(out)), fall.card).length} in ${journalPathOf(out)}`)
    return
  }

  if (revoke !== null) {
    await appendJournalEvent(journalPathOf(out), revokeEvent(revoke.sha256, revoke.card, new Date().toISOString()))
    console.log(`card #${revoke.card}: approval ${revoke.sha256.slice(0, 7)} revoked in ${journalPathOf(out)}`)
    return
  }

  const { baseSha, prepared, byMorse, refusals } = await prepareAndPreflight(repo, status, out, matrix, tasks, ownerAllows)

  if (refusals.length > 0) {
    for (const refusal of refusals)
      console.error(refusal)
    process.exitCode = 1
    return
  }

  console.log(`DECISION: open ${prepared.length} sessions`)
  const style = terminalStyle(process.stdout.isTTY, process.env.NO_COLOR)
  for (const task of prepared) {
    for (const line of describeTask(task, baseSha, byMorse, style))
      console.log(line)
  }

  const answer = await readLine()
  if (answer !== 'yes') {
    process.exitCode = 1
    return
  }

  const journalPath = journalPathOf(out)
  const ctx: TaskContext = { repo, statusPath: status, journalPath, baseSha, out, matrixPath: matrix }
  for (const event of ownerAllowsEvents(prepared, ownerAllows))
    await appendJournalEvent(journalPath, event)
  for (const task of prepared)
    await appendJournalEvent(journalPath, launchEntryEvent(task, baseSha, byMorse))
  const results = await superviseBatch({ ctx, tasks: prepared })
  if (results === null)
    return

  let allOk = true
  for (const result of results) {
    console.log(`${result.id}: ${result.line}`)
    if (!result.ok)
      allOk = false
  }

  process.exitCode = allOk ? 0 : 1
}

await main()
