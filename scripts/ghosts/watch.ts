import type { Task, TasksFile } from './tasks.js'
import type { ProcessListing } from './watch-process.js'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { parseEverySeconds, sleep } from './every.js'
import { ghostRowSessionId } from './status.js'
import { readTasksFile, startedTree } from './tasks.js'
import { readLedgerStage } from './watch-ledger.js'
import { listProcesses, processField } from './watch-process.js'
import { lastToolName, reportAgeField } from './watch-report.js'

const PREFIX = '[ghosts:watch] '

function print(line: string): void {
  console.log(`${PREFIX}${line}`)
}

function printError(message: string): void {
  for (const line of message.split('\n'))
    console.error(`${PREFIX}${line}`)
}

interface Args {
  tasksFile: string
  everySeconds: number | undefined
}

function parseArgs(argv: string[]): Args {
  let tasksFile: string | undefined
  let everyRaw: string | undefined

  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (flag !== '--tasks' && flag !== '--every')
      throw new Error(`unknown argument '${flag}': usage --tasks <file> [--every <seconds>]`)
    if (value === undefined || value.startsWith('--'))
      throw new Error(`${flag} needs a value, got ${value === undefined ? 'nothing' : `the flag '${value}'`}`)
    if (flag === '--tasks')
      tasksFile = value
    else
      everyRaw = value
  }

  if (tasksFile === undefined)
    throw new Error('--tasks is required: usage --tasks <file> [--every <seconds>]')

  return { tasksFile, everySeconds: everyRaw === undefined ? undefined : parseEverySeconds(everyRaw) }
}

function stageField(runsPath: string): string {
  const stage = readLedgerStage(runsPath)
  if (stage === null)
    return 'stage no ledger lines'
  return stage.kind === 'writing' ? 'ledger: writing' : `stage ${stage.status} ${stage.run}`
}

function treeStageField(task: Task, journalText: string): string {
  const tree = startedTree(journalText, task.card)
  return tree === undefined ? `stage no task:start line for card #${task.card.id}` : stageField(path.join(tree.worktree, '.construct', 'runs.jsonl'))
}

function taskLine(task: Task, out: string, journalText: string, statusText: string | undefined, processes: ProcessListing): string {
  const reportPath = path.join(out, `ghost-${task.id}.jsonl`)
  const reportField = reportAgeField(reportPath)
  const tool = lastToolName(reportPath)
  const toolField = `tool ${tool ?? 'none'}`

  const ledgerField = treeStageField(task, journalText)
  const sessionId = statusText === undefined ? undefined : ghostRowSessionId(statusText, task.id)

  return `ghost-${task.id} | ${reportField} | ${toolField} | ${ledgerField} | ${processField(sessionId, processes)}`
}

function drawFrame(tasksData: TasksFile): void {
  const at = new Date().toISOString()
  const statusText = existsSync(tasksData.status) ? readFileSync(tasksData.status, 'utf8') : undefined
  const journalPath = path.join(tasksData.out, 'ghosts.jsonl')
  const journalText = existsSync(journalPath) ? readFileSync(journalPath, 'utf8') : ''
  const processes = listProcesses()
  const lines = tasksData.tasks.map(task => taskLine(task, tasksData.out, journalText, statusText, processes))
  print(`frame ${at}`)
  for (const line of lines)
    print(line)
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const tasksData = readTasksFile(args.tasksFile)

  if (args.everySeconds === undefined) {
    drawFrame(tasksData)
    return
  }

  for (;;) {
    drawFrame(tasksData)
    await sleep(args.everySeconds * 1000)
  }
}

try {
  await main()
}
catch (error) {
  printError(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
