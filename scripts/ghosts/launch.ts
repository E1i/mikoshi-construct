import type { Task } from './tasks.js'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { createInterface } from 'node:readline'
import { checkApproval, sha256Hex } from './approval.js'
import { spawnSession } from './session.js'
import { freeRow, ghostRowState, writeGhostRow, writingRow } from './status.js'
import { readTasksFile } from './tasks.js'

interface PreparedTask extends Task {
  approvedText: string
  approvedHashShort: string
  sessionId: string
  reportPath: string
  stderrPath: string
}

function timestamp(date: Date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim()
}

function branchExists(repo: string, branch: string): boolean {
  try {
    execFileSync('git', ['-C', repo, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { stdio: 'pipe' })
    return true
  }
  catch {
    return false
  }
}

function parseArgs(argv: string[]): { tasksFile: string } {
  const index = argv.indexOf('--tasks')
  if (index === -1 || index === argv.length - 1)
    throw new Error('usage: launch.ts --tasks <file>')
  return { tasksFile: argv[index + 1] }
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

async function prepareAndPreflight(repo: string, statusPath: string, out: string, tasks: Task[]): Promise<{ baseSha: string, prepared: PreparedTask[], refusals: string[] }> {
  const refusals: string[] = []

  git(repo, ['fetch', 'origin', 'main'])
  const baseSha = git(repo, ['rev-parse', 'origin/main'])

  const statusText = existsSync(statusPath) ? await readFile(statusPath, 'utf8') : undefined
  const prepared: PreparedTask[] = []

  for (const task of tasks) {
    const approval = checkApproval(task.brief)
    if (!approval.ok) {
      refusals.push(`task ${task.id}: ${approval.reason}`)
      continue
    }

    if (existsSync(task.worktree))
      refusals.push(`task ${task.id}: worktree already exists at ${task.worktree}`)

    if (branchExists(repo, task.branch))
      refusals.push(`task ${task.id}: branch ${task.branch} already exists`)

    if (statusText !== undefined) {
      const state = ghostRowState(statusText, task.id)
      if (state === 'writing' || state === 'reviewing')
        refusals.push(`task ${task.id}: status.md row ghost-${task.id} is busy (state ${state})`)
    }

    const reportPath = path.join(out, `ghost-${task.id}.jsonl`)
    if (existsSync(reportPath))
      refusals.push(`task ${task.id}: report file ${reportPath} already exists`)

    prepared.push({
      ...task,
      approvedText: approval.text,
      approvedHashShort: sha256Hex(approval.text).slice(0, 7),
      sessionId: randomUUID(),
      reportPath,
      stderrPath: path.join(out, `ghost-${task.id}.stderr`),
    })
  }

  return { baseSha, prepared, refusals }
}

function describeTask(task: PreparedTask, baseSha: string): string {
  return `  ${task.id}: /implement ${task.brief} (approved ${task.approvedHashShort}) -> ${task.worktree} on ${task.branch} @ ${baseSha.slice(0, 7)}, report ${task.reportPath}, session ${task.sessionId}`
}

async function launchTask(repo: string, statusPath: string, baseSha: string, task: PreparedTask): Promise<{ id: string, code: number, reportPath: string, sessionId: string }> {
  const start = timestamp()

  execFileSync('git', ['-C', repo, 'worktree', 'add', '-b', task.branch, task.worktree, baseSha], { stdio: 'pipe' })

  await writeGhostRow(statusPath, task.id, writingRow({
    id: task.id,
    worktree: task.worktree,
    baseSha,
    start,
    briefFileName: path.basename(task.brief),
    sessionId: task.sessionId,
  }))

  let code: number
  try {
    code = await spawnSession({
      cwd: task.worktree,
      sessionId: task.sessionId,
      prompt: task.approvedText,
      stdoutPath: task.reportPath,
      stderrPath: task.stderrPath,
    })
  }
  catch {
    code = 1
  }

  const end = timestamp()
  const headSha = git(task.worktree, ['rev-parse', 'HEAD'])

  await writeGhostRow(statusPath, task.id, freeRow({
    id: task.id,
    worktree: task.worktree,
    headSha,
    start,
    end,
    exitCode: code,
    reportPath: task.reportPath,
    sessionId: task.sessionId,
  }))

  return { id: task.id, code, reportPath: task.reportPath, sessionId: task.sessionId }
}

async function main(): Promise<void> {
  const { tasksFile } = parseArgs(process.argv.slice(2))
  const { repo, status, out, tasks } = readTasksFile(tasksFile)

  const { baseSha, prepared, refusals } = await prepareAndPreflight(repo, status, out, tasks)

  if (refusals.length > 0) {
    for (const refusal of refusals)
      console.error(refusal)
    process.exitCode = 1
    return
  }

  console.log(`DECISION: open ${prepared.length} sessions`)
  for (const task of prepared)
    console.log(describeTask(task, baseSha))

  const answer = await readLine()
  if (answer !== 'yes') {
    process.exitCode = 1
    return
  }

  const results = await Promise.all(prepared.map(task => launchTask(repo, status, baseSha, task)))

  let allOk = true
  for (const result of results) {
    console.log(`${result.id}: exit ${result.code}, report ${result.reportPath}, session ${result.sessionId}`)
    if (result.code !== 0)
      allOk = false
  }

  process.exitCode = allOk ? 0 : 1
}

await main()
