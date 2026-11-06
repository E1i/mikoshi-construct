import type { GhPort, GhRead, PullRequest } from './gh.js'
import type { Meter } from './meter.js'
import { stripVTControlCharacters } from 'node:util'
import { GH_QUERY_FAILED, PROCESS_GH_PORT, readGhJson, REQUIRED_CHECK, SECRET_SCAN_CHECK } from './gh.js'

export type CiReading = 'pending' | 'green' | 'red'

export type CiState = 'none' | 'unknown' | CiReading

export interface Ci {
  state: CiState
  text: string
  head: string
  greenAt?: string
}

export interface PrDetails {
  ci: Ci
  files: string[] | undefined
}

export interface CheckRun {
  name?: string
  status?: string
  conclusion?: string | null
}

export interface RollupCheck {
  name?: string
  status?: string
  conclusion?: string
  state?: string
  completedAt?: string
}

export interface CommitCi {
  state: CiReading
  failedChecks: string[]
}

export interface FailedJobLog {
  log: string
  jobLink: string | null
}

export interface RunOnMain {
  databaseId: number
  headSha: string
}

export interface RunStep {
  name: string
  startedAt: string
  completedAt: string
}

export interface RunJob {
  name: string
  conclusion: string
  startedAt: string
  completedAt: string
  steps?: RunStep[]
}

export interface RunIdentity {
  repository: string
  runId: string
}

export interface ArtifactRequest {
  name: string
  dir: string
  repository?: string
}

export type CiRead<T> = GhRead<T>

export type CiAct = { done: true } | { done: false, reason: string }

export interface CiOfCommits {
  onCommit: (sha: string, requiredCheck?: string) => CommitCi
  approvedRunOn: (head: string | undefined) => boolean
}

export interface CiRuns {
  pullRequest: (pr: PullRequest, repository: string) => PrDetails
  failedJobLog: (head: string, tree: string) => FailedJobLog | null
  successfulRunsOnMain: (limit: number) => CiRead<RunOnMain[]>
  jobsOfRun: (runId: number) => CiRead<{ jobs: RunJob[] }>
  artifactsNamed: (run: RunIdentity, name: string) => CiRead<number>
  downloadArtifact: (runId: string | number, artifact: ArtifactRequest) => CiAct
  cancel: (run: RunIdentity) => boolean
}

const REPO = 'repos/{owner}/{repo}'
const RUNS_PAGE = 100
const AWAITING_APPROVAL = 'action_required'
const CI_WORDS: readonly string[] = ['pending', 'green', 'red']
const FAILED_CONCLUSIONS = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure'])
const PASSING_OUTCOMES = ['SUCCESS', 'SKIPPED', 'NEUTRAL']

export function ciWord(value: unknown): CiReading | null {
  return typeof value === 'string' && CI_WORDS.includes(value) ? value as CiReading : null
}

function ciOfRuns(runs: readonly CheckRun[], requiredCheck: string): CiReading {
  const required = runs.find(run => run.name === requiredCheck)
  if (required === undefined || required.status !== 'completed')
    return 'pending'
  if (required.conclusion !== 'success')
    return 'red'
  const secretScan = runs.find(run => run.name === SECRET_SCAN_CHECK)
  if (secretScan === undefined)
    return 'green'
  if (secretScan.status !== 'completed')
    return 'pending'
  return FAILED_CONCLUSIONS.has(secretScan.conclusion ?? '') ? 'red' : 'green'
}

function failedChecksOf(runs: readonly CheckRun[], requiredCheck: string): string[] {
  return runs.flatMap(run => run.name !== undefined && run.name !== requiredCheck && run.status === 'completed' && FAILED_CONCLUSIONS.has(run.conclusion ?? '') ? [run.name] : [])
}

function commitCiOfRuns(runs: readonly CheckRun[], requiredCheck: string): CommitCi {
  const state = ciOfRuns(runs, requiredCheck)
  return { state, failedChecks: state === 'red' ? failedChecksOf(runs, requiredCheck) : [] }
}

function outcomeOf(check: RollupCheck): string | undefined {
  return check.conclusion ?? check.state
}

function runOfRollupCheck(check: RollupCheck): CheckRun {
  return { name: check.name, status: (check.status ?? 'COMPLETED').toLowerCase(), conclusion: outcomeOf(check)?.toLowerCase() ?? null }
}

function isFailing(check: RollupCheck): boolean {
  const outcome = outcomeOf(check)
  return outcome !== undefined && outcome !== '' && !PASSING_OUTCOMES.includes(outcome)
}

function pendingText(checks: readonly RollupCheck[], requiredCheck: string): string {
  if (!checks.some(check => check.name === requiredCheck))
    return `pending (${requiredCheck} not reported)`
  const pending = checks.filter(check => check.status !== undefined && check.status !== 'COMPLETED')
  return `pending (${pending.length} of ${checks.length})`
}

function ciOfRollup(checks: readonly RollupCheck[], head: string, requiredCheck = REQUIRED_CHECK): Ci {
  if (checks.length === 0)
    return { state: 'none', text: `— (no checks recorded on ${head})`, head }
  const state = ciOfRuns(checks.map(runOfRollupCheck), requiredCheck)
  if (state === 'pending')
    return { state, text: `${pendingText(checks, requiredCheck)} on ${head}`, head }
  const required = checks.find(check => check.name === requiredCheck)
  if (state === 'red') {
    const failing = checks.filter(check => check === required || isFailing(check))
    return { state, text: `red (${failing.map(check => check.name ?? '?').join(', ')}) on ${head}`, head }
  }
  const at = required?.completedAt
  return at === undefined
    ? { state, text: `green on ${head}`, head }
    : { state, text: `green ${at} on ${head}`, head, greenAt: at }
}

export class GitHubCommitCi implements CiOfCommits {
  constructor(private readonly meter: Meter) {}

  onCommit(sha: string, requiredCheck = REQUIRED_CHECK): CommitCi {
    const runs = (this.meter.get(`${REPO}/commits/${sha}/check-runs?per_page=100`) as { check_runs?: CheckRun[] }).check_runs ?? []
    return commitCiOfRuns(runs, requiredCheck)
  }

  approvedRunOn(head: string | undefined): boolean {
    if (head === undefined)
      return false
    const runs = (this.meter.get(`${REPO}/actions/runs?head_sha=${head}&per_page=${RUNS_PAGE}`) as { workflow_runs?: { conclusion?: string | null }[] }).workflow_runs ?? []
    return runs.some(run => run.conclusion !== AWAITING_APPROVAL)
  }
}

export function ciOf(meter: Meter, sha: string, requiredCheck = REQUIRED_CHECK): CiReading {
  return new GitHubCommitCi(meter).onCommit(sha, requiredCheck).state
}

export function failedJobLinkIn(jobsJson: string): string | null {
  try {
    const { jobs } = JSON.parse(jobsJson) as { jobs: { conclusion?: string, url?: string }[] }
    return jobs.find(job => job.conclusion === 'failure')?.url ?? null
  }
  catch {
    return null
  }
}

export class GhCiRuns implements CiRuns {
  constructor(private readonly gh: GhPort = PROCESS_GH_PORT) {}

  private read<T>(args: string[]): CiRead<T> {
    return readGhJson<T>(call => this.gh.call(call), args)
  }

  pullRequest(pr: PullRequest, repository: string): PrDetails {
    const view = this.read<{ headRefOid?: string, statusCheckRollup?: RollupCheck[], files?: { path: string }[] }>(['pr', 'view', String(pr.number), '-R', repository, '--json', 'headRefOid,statusCheckRollup,files'])
    if (view.kind === 'failed') {
      const reason = view.cause === 'timeout' ? view.reason : GH_QUERY_FAILED
      return { ci: { state: 'unknown', text: `UNKNOWN (missing: checks; ${reason})`, head: pr.headRefOid.slice(0, 7) }, files: undefined }
    }
    return { ci: ciOfRollup(view.value.statusCheckRollup ?? [], (view.value.headRefOid ?? pr.headRefOid).slice(0, 7)), files: view.value.files?.map(file => file.path) }
  }

  failedJobLog(head: string, tree: string): FailedJobLog | null {
    const runs = this.gh.call(['run', 'list', '--commit', head, '--status', 'failure', '--json', 'databaseId', '--limit', '1'], { cwd: tree })
    if (runs.kind !== 'ran')
      return null
    try {
      const [run] = JSON.parse(runs.stdout) as { databaseId: number }[]
      if (run === undefined)
        return null
      const log = this.gh.call(['run', 'view', String(run.databaseId), '--log-failed'], { cwd: tree })
      if (log.kind !== 'ran')
        return null
      const jobs = this.gh.call(['run', 'view', String(run.databaseId), '--json', 'jobs'], { cwd: tree })
      return { log: log.stdout, jobLink: jobs.kind === 'ran' ? failedJobLinkIn(jobs.stdout) : null }
    }
    catch {
      return null
    }
  }

  successfulRunsOnMain(limit: number): CiRead<RunOnMain[]> {
    return this.read<RunOnMain[]>(['run', 'list', '--workflow', 'CI', '--branch', 'main', '--event', 'push', '--status', 'success', '--limit', String(limit), '--json', 'databaseId,headSha'])
  }

  jobsOfRun(runId: number): CiRead<{ jobs: RunJob[] }> {
    return this.read<{ jobs: RunJob[] }>(['run', 'view', String(runId), '--json', 'jobs'])
  }

  artifactsNamed(run: RunIdentity, name: string): CiRead<number> {
    const artifacts = this.read<{ total_count?: number }>(['api', `repos/${run.repository}/actions/runs/${run.runId}/artifacts?name=${name}`])
    return artifacts.kind === 'failed' ? artifacts : { kind: 'read', value: artifacts.value.total_count ?? 0 }
  }

  downloadArtifact(runId: string | number, artifact: ArtifactRequest): CiAct {
    const repository = artifact.repository === undefined ? [] : ['--repo', artifact.repository]
    const downloaded = this.gh.call(['run', 'download', String(runId), ...repository, '--name', artifact.name, '--dir', artifact.dir])
    return downloaded.kind === 'ran' ? { done: true } : { done: false, reason: downloaded.reason }
  }

  cancel(run: RunIdentity): boolean {
    return this.gh.call(['run', 'cancel', run.runId, '--repo', run.repository]).kind === 'ran'
  }
}

export interface CiWorld {
  commits?: Record<string, CheckRun[]>
  approvedHeads?: string[]
  rollups?: Record<number, RollupCheck[]>
  failedLogs?: Record<string, FailedJobLog>
  runsOnMain?: RunOnMain[]
  jobs?: Record<number, RunJob[]>
  artifacts?: Record<string, string[]>
}

export class InMemoryCi implements CiOfCommits, CiRuns {
  readonly cancelled: RunIdentity[] = []
  readonly downloaded: ArtifactRequest[] = []

  constructor(private readonly world: CiWorld = {}) {}

  onCommit(sha: string, requiredCheck = REQUIRED_CHECK): CommitCi {
    return commitCiOfRuns(this.world.commits?.[sha] ?? [], requiredCheck)
  }

  approvedRunOn(head: string | undefined): boolean {
    return head !== undefined && (this.world.approvedHeads ?? []).includes(head)
  }

  pullRequest(pr: PullRequest): PrDetails {
    return { ci: ciOfRollup(this.world.rollups?.[pr.number] ?? [], pr.headRefOid.slice(0, 7)), files: [] }
  }

  failedJobLog(head: string): FailedJobLog | null {
    return this.world.failedLogs?.[head] ?? null
  }

  successfulRunsOnMain(limit: number): CiRead<RunOnMain[]> {
    return { kind: 'read', value: (this.world.runsOnMain ?? []).slice(0, limit) }
  }

  jobsOfRun(runId: number): CiRead<{ jobs: RunJob[] }> {
    return { kind: 'read', value: { jobs: this.world.jobs?.[runId] ?? [] } }
  }

  artifactsNamed(run: RunIdentity, name: string): CiRead<number> {
    return { kind: 'read', value: (this.world.artifacts?.[run.runId] ?? []).filter(artifact => artifact === name).length }
  }

  downloadArtifact(runId: string | number, artifact: ArtifactRequest): CiAct {
    if (!(this.world.artifacts?.[String(runId)] ?? []).includes(artifact.name))
      return { done: false, reason: `no artifact ${artifact.name} on run ${runId}` }
    this.downloaded.push(artifact)
    return { done: true }
  }

  cancel(run: RunIdentity): boolean {
    this.cancelled.push(run)
    return true
  }
}

export const CI_LOG_CEILING = 20_000
const TAIL_CEILING = 5_000
const LINES_BEFORE_FAILURE = 2
const LINES_AFTER_FAILURE = 20

const JOB_STEP_AND_STAMP = /^(?:[^\t]*\t[^\t]*\t)?\uFEFF?(?:\d{4}-\d{2}-\d{2}T[\d:.]+Z ?)?/
const FAILURE_MARKER = /\b(?:FAIL(?:ED)?|ERROR)\b|\b\w*Error\b|##\[error\]/
const GREEN_TEST = /^(?:[✓✔√]|PASS\b)/
const RUNNER_SETUP_PREFIXES = [
  '##[group]',
  '##[endgroup]',
  '[command]',
  'Current runner version',
  'Runner name',
  'Runner group name',
  'Runner Image',
  'Machine name',
  'Hosted Compute Agent',
  'Operating System',
  'Image:',
  'Image Release:',
  'Version:',
  'Included Software:',
  'GITHUB_TOKEN Permissions',
  'Secret source',
  'Prepare workflow directory',
  'Prepare all required actions',
  'Getting action download info',
  'Download action repository',
  'Download immutable action',
  'Complete job name',
  'Syncing repository',
  'Getting Git version info',
  'Temporarily overriding HOME',
  'Adding repository directory',
  'Deleting the contents',
  'Initializing the repository',
  'Disabling automatic garbage collection',
  'Setting up auth',
  'Fetching the repository',
  'Determining the checkout info',
  'Checking out the ref',
]

function messageOf(line: string): string {
  return line.replace(JOB_STEP_AND_STAMP, '').trimStart()
}

function isNoise(line: string): boolean {
  const message = messageOf(line)
  return GREEN_TEST.test(message) || RUNNER_SETUP_PREFIXES.some(prefix => message.startsWith(prefix))
}

function linesWorthReading(log: string): string[] {
  const all = log.split('\n')
  const kept = all.filter(line => !isNoise(line))
  return kept.some(line => messageOf(line) !== '') ? kept : all
}

function tailStart(lines: readonly string[]): number {
  let start = lines.length - 1
  let size = lines[start]!.length
  while (start > 0 && size + lines[start - 1]!.length < TAIL_CEILING) {
    start -= 1
    size += lines[start]!.length + 1
  }
  return start
}

function failureBlocks(lines: readonly string[], end: number): string[] {
  const inBlock = new Set<number>()
  lines.forEach((line, at) => {
    if (FAILURE_MARKER.test(messageOf(line))) {
      for (let near = Math.max(0, at - LINES_BEFORE_FAILURE); near <= at + LINES_AFTER_FAILURE; near += 1)
        inBlock.add(near)
    }
  })
  const blocks: string[][] = []
  for (let at = 0; at < end; at += 1) {
    if (!inBlock.has(at))
      continue
    if (inBlock.has(at - 1))
      blocks.at(-1)!.push(lines[at]!)
    else
      blocks.push([lines[at]!])
  }
  return blocks.map(block => block.join('\n'))
}

function blocksInTheirRoom(blocks: readonly string[], room: number): string {
  const smallestFirst = blocks.map((text, at) => ({ text, at })).sort((one, other) => one.text.length - other.text.length)
  const carried: { text: string, at: number }[] = []
  let left = room
  for (const { text, at } of smallestFirst) {
    if (left <= 0)
      break
    const piece = text.slice(0, left)
    carried.push({ text: piece, at })
    left -= piece.length + 1
  }
  return carried.sort((one, other) => one.at - other.at).map(block => block.text).join('\n')
}

function cutLine(characters: number, jobLink: string | null): string {
  return `cut: ${characters} characters, full log: ${jobLink ?? 'the job link is unread'}`
}

export function ciLogForPrompt({ log, jobLink }: FailedJobLog): string {
  const clean = stripVTControlCharacters(log).trimEnd()
  const room = CI_LOG_CEILING - cutLine(clean.length, jobLink).length - 1
  const lines = linesWorthReading(clean)
  const tailFrom = tailStart(lines)
  const tail = lines.slice(tailFrom).join('\n').slice(-TAIL_CEILING)
  const blocks = blocksInTheirRoom(failureBlocks(lines, tailFrom), room - tail.length - 1)
  const carried = blocks === '' ? tail : `${blocks}\n${tail}`
  return `${carried}\n${cutLine(clean.length - carried.length, jobLink)}`
}
