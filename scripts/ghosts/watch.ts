import type { Task, TasksFile } from './tasks.js'
import type { ProcessRow } from './watch-process.js'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { ghostRowSessionId } from './status.js'
import { readTasksFile } from './tasks.js'
import { readLedgerStage } from './watch-ledger.js'
import { isSessionAlive, listProcesses } from './watch-process.js'
import { lastToolName, reportAgeSeconds } from './watch-report.js'

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

  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--tasks') {
      tasksFile = argv[index + 1]
      index += 1
    }
    else if (argv[index] === '--every') {
      everyRaw = argv[index + 1]
      index += 1
    }
  }

  if (tasksFile === undefined)
    throw new Error('--tasks is required: usage --tasks <file> [--every <seconds>]')

  let everySeconds: number | undefined
  if (everyRaw !== undefined) {
    if (!/^\d+$/.test(everyRaw) || Number(everyRaw) < 1)
      throw new Error(`--every must be a whole number of seconds of at least 1, got '${everyRaw}'`)
    everySeconds = Number(everyRaw)
  }

  return { tasksFile, everySeconds }
}

function taskLine(task: Task, out: string, statusText: string | undefined, processes: ProcessRow[]): string {
  const reportPath = path.join(out, `ghost-${task.id}.jsonl`)
  const age = reportAgeSeconds(reportPath)
  const reportField = age === null ? 'no report' : `report ${age}s`
  const tool = lastToolName(reportPath)
  const toolField = `tool ${tool ?? 'none'}`

  const runsPath = path.join(task.worktree, '.construct', 'runs.jsonl')
  const stage = readLedgerStage(runsPath)
  const stageField = stage === null ? 'stage no ledger lines' : `stage ${stage.status} ${stage.run}`

  const sessionId = statusText === undefined ? undefined : ghostRowSessionId(statusText, task.id)
  const processField = sessionId === undefined
    ? 'process no session'
    : isSessionAlive(sessionId, processes) ? 'process alive' : 'process dead'

  return `ghost-${task.id} | ${reportField} | ${toolField} | ${stageField} | ${processField}`
}

function drawFrame(tasksData: TasksFile): void {
  print(`frame ${new Date().toISOString()}`)
  const statusText = existsSync(tasksData.status) ? readFileSync(tasksData.status, 'utf8') : undefined
  const processes = listProcesses()
  for (const task of tasksData.tasks)
    print(taskLine(task, tasksData.out, statusText, processes))
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
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
