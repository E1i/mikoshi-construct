import type { Task, TasksFile } from './tasks.js'
import type { ProcessListing } from './watch-process.js'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { execGh, listPrs } from '../board/gh.js'
import { cleanupMerged } from './cleanup.js'
import { parseEverySeconds, sleep } from './every.js'
import { ghostRowSessionId } from './status.js'
import { readTasksFile } from './tasks.js'
import { readLedgerStage } from './watch-ledger.js'
import { listProcesses, processField } from './watch-process.js'
import { lastToolName, reportAgeField } from './watch-report.js'

const PREFIX = '[ghosts:watch] '
const DEFAULT_REPO = 'E1i/mikoshi-construct'
const DEFAULT_LOGS_DIR = '/tmp'
const USAGE = 'usage --tasks <file> [--every <seconds>] [--repo <owner/name>] [--logs <dir>]'
const FLAGS = ['--tasks', '--every', '--repo', '--logs']

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
  repo: string
  logsDir: string
}

function parseArgs(argv: string[]): Args {
  const values = new Map<string, string>()

  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (!FLAGS.includes(flag))
      throw new Error(`unknown argument '${flag}': ${USAGE}`)
    if (value === undefined || value.startsWith('--'))
      throw new Error(`${flag} needs a value, got ${value === undefined ? 'nothing' : `the flag '${value}'`}`)
    values.set(flag, value)
  }

  const tasksFile = values.get('--tasks')
  if (tasksFile === undefined)
    throw new Error(`--tasks is required: ${USAGE}`)

  const everyRaw = values.get('--every')
  return {
    tasksFile,
    everySeconds: everyRaw === undefined ? undefined : parseEverySeconds(everyRaw),
    repo: values.get('--repo') ?? DEFAULT_REPO,
    logsDir: values.get('--logs') ?? DEFAULT_LOGS_DIR,
  }
}

function stageField(runsPath: string): string {
  const stage = readLedgerStage(runsPath)
  if (stage === null)
    return 'stage no ledger lines'
  return stage.kind === 'writing' ? 'ledger: writing' : `stage ${stage.status} ${stage.run}`
}

function taskLine(task: Task, out: string, statusText: string | undefined, processes: ProcessListing): string {
  const reportPath = path.join(out, `ghost-${task.id}.jsonl`)
  const reportField = reportAgeField(reportPath)
  const tool = lastToolName(reportPath)
  const toolField = `tool ${tool ?? 'none'}`

  const ledgerField = stageField(path.join(task.worktree, '.construct', 'runs.jsonl'))
  const sessionId = statusText === undefined ? undefined : ghostRowSessionId(statusText, task.id)

  return `ghost-${task.id} | ${reportField} | ${toolField} | ${ledgerField} | ${processField(sessionId, processes)}`
}

function drawFrame(tasksData: TasksFile, args: Args): void {
  const at = new Date().toISOString()
  const statusText = existsSync(tasksData.status) ? readFileSync(tasksData.status, 'utf8') : undefined
  const processes = listProcesses()
  const lines = tasksData.tasks.map(task => taskLine(task, tasksData.out, statusText, processes))
  print(`frame ${at}`)
  for (const line of lines)
    print(line)

  const ctx = { repo: tasksData.repo, prs: listPrs(execGh, args.repo), statusText, journalPath: path.join(tasksData.out, 'ghosts.jsonl'), logsDir: args.logsDir }
  for (const task of tasksData.tasks) {
    const cleanup = cleanupMerged(task, ctx)
    if (cleanup !== undefined)
      print(cleanup)
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const tasksData = readTasksFile(args.tasksFile)

  if (args.everySeconds === undefined) {
    drawFrame(tasksData, args)
    return
  }

  for (;;) {
    drawFrame(tasksData, args)
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
