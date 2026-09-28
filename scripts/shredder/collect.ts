import type { SpawnSyncReturns } from 'node:child_process'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { extractImplementText } from '../ghosts/approval.js'

class CollectError extends Error {}

function refuse(message: string): never {
  throw new CollectError(message)
}

interface BriefTask { id: string, kind: 'brief', brief: string, worktree?: string }
interface IssueTask { id: string, kind: 'issue', issue: number }
type QueueTask = BriefTask | IssueTask

interface Queue {
  repo: string
  status: string
  ownerMerges: string
  tasks: QueueTask[]
}

const OUTPUT_LIMIT_BYTES = 1024 ** 3

const TOP_KEYS = ['repo', 'status', 'ownerMerges', 'tasks']
const TASK_KEYS = ['id', 'brief', 'worktree', 'issue']

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseTask(queuePath: string, index: number, raw: unknown): QueueTask {
  const label = `task ${index + 1}`
  if (!isPlainObject(raw))
    refuse(`${queuePath}: ${label} must be a JSON object`)

  for (const key of Object.keys(raw)) {
    if (!TASK_KEYS.includes(key))
      refuse(`${queuePath}: ${label}: unknown key '${key}'`)
  }

  if (!('id' in raw))
    refuse(`${queuePath}: ${label}: missing key 'id'`)
  if (!nonEmptyString(raw.id))
    refuse(`${queuePath}: ${label}: 'id' must be a non-empty string`)

  const hasBrief = 'brief' in raw
  const hasIssue = 'issue' in raw
  if (hasBrief && hasIssue)
    refuse(`${queuePath}: ${label}: both 'brief' and 'issue' given`)
  if (!hasBrief && !hasIssue)
    refuse(`${queuePath}: ${label}: missing key 'brief' or 'issue'`)

  if (hasIssue) {
    if ('worktree' in raw)
      refuse(`${queuePath}: ${label}: 'worktree' is only valid with 'brief'`)
    if (typeof raw.issue !== 'number' || !Number.isInteger(raw.issue) || raw.issue <= 0)
      refuse(`${queuePath}: ${label}: 'issue' must be a positive integer`)
    return { id: raw.id, kind: 'issue', issue: raw.issue }
  }

  if (!nonEmptyString(raw.brief))
    refuse(`${queuePath}: ${label}: 'brief' must be a non-empty string`)
  const task: BriefTask = { id: raw.id, kind: 'brief', brief: path.resolve(path.dirname(queuePath), raw.brief) }
  if ('worktree' in raw) {
    if (!nonEmptyString(raw.worktree))
      refuse(`${queuePath}: ${label}: 'worktree' must be a non-empty string`)
    task.worktree = raw.worktree
  }
  return task
}

function parseQueue(queuePath: string, raw: unknown): Queue {
  if (!isPlainObject(raw))
    refuse(`${queuePath}: the queue must be a JSON object`)

  for (const key of Object.keys(raw)) {
    if (!TOP_KEYS.includes(key))
      refuse(`${queuePath}: unknown key '${key}'`)
  }
  for (const key of TOP_KEYS) {
    if (!(key in raw))
      refuse(`${queuePath}: missing key '${key}'`)
  }

  if (!nonEmptyString(raw.repo))
    refuse(`${queuePath}: 'repo' must be a non-empty string`)
  if (!nonEmptyString(raw.status))
    refuse(`${queuePath}: 'status' must be a non-empty string`)
  if (!nonEmptyString(raw.ownerMerges))
    refuse(`${queuePath}: 'ownerMerges' must be a non-empty string`)
  if (!Array.isArray(raw.tasks))
    refuse(`${queuePath}: 'tasks' must be an array`)

  const queueDir = path.dirname(queuePath)
  return {
    repo: path.resolve(queueDir, raw.repo),
    status: path.resolve(queueDir, raw.status),
    ownerMerges: path.resolve(queueDir, raw.ownerMerges),
    tasks: raw.tasks.map((task, index) => parseTask(queuePath, index, task)),
  }
}

function readQueue(queuePath: string): Queue {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(queuePath, 'utf8'))
  }
  catch (error) {
    return refuse(`${queuePath}: ${(error as Error).message}`)
  }
  return parseQueue(queuePath, raw)
}

function ghEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  delete env.GH_REPO
  return env
}

function checkedOutput(call: string, repo: string, result: SpawnSyncReturns<string>): string {
  if (result.error !== undefined || result.status !== 0)
    refuse(`${call} failed in ${repo}: ${(result.error?.message || result.stderr || result.stdout || '').trim()}`)
  return result.stdout
}

function runGit(repo: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: OUTPUT_LIMIT_BYTES })
  return checkedOutput(`git ${args.join(' ')}`, repo, result)
}

function runGhJson<T>(repo: string, args: string[]): T {
  const call = `gh ${args.join(' ')}`
  const output = checkedOutput(call, repo, spawnSync('gh', args, { cwd: repo, encoding: 'utf8', env: ghEnv(), maxBuffer: OUTPUT_LIMIT_BYTES }))
  try {
    return JSON.parse(output) as T
  }
  catch (error) {
    return refuse(`${call} in ${repo} did not return JSON: ${(error as Error).message}`)
  }
}

function listTrackedFiles(repo: string): string[] {
  const output = runGit(repo, ['ls-files', '-z'])
  return output.split('\0').filter(entry => entry.length > 0)
}

interface RawPr {
  number: number
  title: string
  headRefOid: string
  files: { path: string }[]
}

function fetchOpenPrs(repo: string): RawPr[] {
  return runGhJson<RawPr[]>(repo, ['pr', 'list', '--state', 'open', '--limit', '1000', '--json', 'number,title,headRefOid,files'])
}

function hasAwaitingRun(repo: string, sha: string): boolean {
  const runs = runGhJson<{ conclusion: string }[]>(repo, ['run', 'list', '--commit', sha, '--limit', '1000', '--json', 'conclusion'])
  return runs.some(run => run.conclusion === 'action_required')
}

interface CollectedPr {
  number: number
  title: string
  runsAwaitingApproval: boolean
  files: string[]
}

function collectOpenPrs(repo: string): CollectedPr[] {
  return fetchOpenPrs(repo).map(pr => ({
    number: pr.number,
    title: pr.title,
    runsAwaitingApproval: hasAwaitingRun(repo, pr.headRefOid),
    files: pr.files.map(file => file.path),
  }))
}

function issueText(title: string, body: string): string {
  const pathsLine = body.split('\n').find(line => line.startsWith('Paths:'))
  if (pathsLine === undefined)
    return `# ${title}\n`
  return `# ${title}\n\n${pathsLine}\n`
}

function briefText(briefPath: string, worktree: string | undefined): string {
  const content = readFileSync(briefPath, 'utf8')
  const approved = extractImplementText(content)
  if (approved === undefined)
    refuse(`${briefPath}: no approved instruction line`)
  if (worktree === undefined)
    return approved
  return `Worktree: ${worktree}\n\n${approved}`
}

function taskFileName(index: number, task: QueueTask): string {
  const nn = String(index + 1).padStart(2, '0')
  return `${nn}-${task.id}.${task.kind}.md`
}

function writeTasks(tmpDir: string, queue: Queue): void {
  const tasksDir = path.join(tmpDir, 'tasks')
  mkdirSync(tasksDir, { recursive: true })

  queue.tasks.forEach((task, index) => {
    const fileName = taskFileName(index, task)
    if (task.kind === 'brief') {
      writeFileSync(path.join(tasksDir, fileName), briefText(task.brief, task.worktree))
      return
    }
    const { title, body } = runGhJson<{ title: string, body: string }>(queue.repo, ['issue', 'view', String(task.issue), '--json', 'title,body'])
    writeFileSync(path.join(tasksDir, fileName), issueText(title, body))
  })
}

function copyBytes(from: string, to: string): void {
  writeFileSync(to, readFileSync(from))
}

function collect(queue: Queue, tmpDir: string): void {
  const files = listTrackedFiles(queue.repo)
  writeFileSync(path.join(tmpDir, 'files.txt'), files.length > 0 ? `${files.join('\n')}\n` : '')

  const openPrs = collectOpenPrs(queue.repo)
  writeFileSync(path.join(tmpDir, 'open-prs.json'), `${JSON.stringify(openPrs, null, 2)}\n`)

  writeTasks(tmpDir, queue)

  copyBytes(queue.status, path.join(tmpDir, 'status.md'))
  copyBytes(queue.ownerMerges, path.join(tmpDir, 'owner-merges.md'))
}

function parseArgs(argv: string[]): { queuePath: string, outPath: string } {
  const queueIndex = argv.indexOf('--queue')
  const outIndex = argv.indexOf('--out')
  if (queueIndex === -1 || outIndex === -1 || argv[queueIndex + 1] === undefined || argv[outIndex + 1] === undefined)
    refuse('usage: collect.ts --queue <file> --out <dir>')
  return { queuePath: argv[queueIndex + 1]!, outPath: argv[outIndex + 1]! }
}

function main(): void {
  const { queuePath, outPath } = parseArgs(process.argv.slice(2))
  const queue = readQueue(queuePath)

  if (existsSync(outPath))
    refuse(`${outPath} already exists`)

  const tmpDir = mkdtempSync(path.join(path.dirname(path.resolve(outPath)), '.collect-'))
  try {
    collect(queue, tmpDir)
  }
  catch (error) {
    rmSync(tmpDir, { recursive: true, force: true })
    throw error
  }

  if (existsSync(outPath)) {
    rmSync(tmpDir, { recursive: true, force: true })
    refuse(`${outPath} appeared during the run`)
  }

  try {
    renameSync(tmpDir, outPath)
  }
  catch (error) {
    rmSync(tmpDir, { recursive: true, force: true })
    refuse(`renaming ${tmpDir} to ${outPath} failed: ${(error as Error).message}`)
  }
}

try {
  main()
}
catch (error) {
  process.stderr.write(`${(error as Error).message}\n`)
  process.exitCode = 1
}
