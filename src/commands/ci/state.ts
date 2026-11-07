import { stripVTControlCharacters } from 'node:util'

export const PRS_COMMAND = 'gh pr list --state all --limit 100 --json number,title,state,createdAt,closedAt,mergedAt,statusCheckRollup'
export const REQUIRED_CHECK = 'required'
export const SECRET_SCAN_CHECK = 'Secret scan'

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

export interface PullRequestView {
  headRefOid?: string
  statusCheckRollup?: RollupCheck[]
  files?: { path: string }[]
}

export interface CommitCi {
  state: CiReading
  failedChecks: string[]
}

export interface CiObservation {
  ci: CiReading
  failed_checks?: string[]
}

export interface FailedJobLog {
  log: string
  jobLink: string | null
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

export interface BoardCheck {
  status?: string
  conclusion?: string
  context?: string
  state?: string
  completedAt?: string
}

export interface BoardCi {
  state: 'none' | CiReading
  completedAt: string | undefined
}

export interface EndpointReader {
  get: (endpoint: string) => unknown
}

export type CiCommandRun = { kind: 'ran', stdout: string } | { kind: 'failed' }

export type CiCommand = (args: string[]) => CiCommandRun

const REPO = 'repos/{owner}/{repo}'
const RUNS_PAGE = 100
const CHECK_RUNS_PAGE = 100
const SHORT_HEAD_LENGTH = 7
const AWAITING_APPROVAL = 'action_required'
const CI_WORDS: readonly string[] = ['pending', 'green', 'red']
const FAILED_CONCLUSIONS = new Set(['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure'])
const PASSING_OUTCOMES = ['SUCCESS', 'SKIPPED', 'NEUTRAL']
const FAILING_STATES = ['FAILURE', 'ERROR']
const UNFINISHED_STATES = ['PENDING', 'EXPECTED']

export function ciWord(value: unknown): CiReading | null {
  return typeof value === 'string' && CI_WORDS.includes(value) ? value as CiReading : null
}

export function ciFieldsOfObservation({ state, failedChecks }: CommitCi): CiObservation {
  return { ci: state, ...(failedChecks.length === 0 ? {} : { failed_checks: failedChecks }) }
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

export function commitCiOfRuns(runs: readonly CheckRun[], requiredCheck: string): CommitCi {
  const state = ciOfRuns(runs, requiredCheck)
  return { state, failedChecks: state === 'red' ? failedChecksOf(runs, requiredCheck) : [] }
}

export function commitCi(reader: EndpointReader, sha: string, requiredCheck = REQUIRED_CHECK): CommitCi {
  const runs = (reader.get(`${REPO}/commits/${sha}/check-runs?per_page=${CHECK_RUNS_PAGE}`) as { check_runs?: CheckRun[] }).check_runs ?? []
  return commitCiOfRuns(runs, requiredCheck)
}

export function ciOf(reader: EndpointReader, sha: string, requiredCheck = REQUIRED_CHECK): CiReading {
  return commitCi(reader, sha, requiredCheck).state
}

export function hasApprovedRun(reader: EndpointReader, head: string | undefined): boolean {
  if (head === undefined)
    return false
  const runs = (reader.get(`${REPO}/actions/runs?head_sha=${head}&per_page=${RUNS_PAGE}`) as { workflow_runs?: { conclusion?: string | null }[] }).workflow_runs ?? []
  return runs.some(run => run.conclusion !== AWAITING_APPROVAL)
}

function outcomeOf(check: RollupCheck): string | undefined {
  return check.conclusion ?? check.state
}

function runOfRollupCheck(check: RollupCheck): CheckRun {
  return { name: check.name, status: (check.status ?? 'COMPLETED').toLowerCase(), conclusion: outcomeOf(check)?.toLowerCase() ?? null }
}

function isFailingOutcome(check: RollupCheck): boolean {
  const outcome = outcomeOf(check)
  return outcome !== undefined && outcome !== '' && !PASSING_OUTCOMES.includes(outcome)
}

function pendingText(checks: readonly RollupCheck[], requiredCheck: string): string {
  if (!checks.some(check => check.name === requiredCheck))
    return `pending (${requiredCheck} not reported)`
  const pending = checks.filter(check => check.status !== undefined && check.status !== 'COMPLETED')
  return `pending (${pending.length} of ${checks.length})`
}

export function ciOfRollup(checks: readonly RollupCheck[], head: string, requiredCheck = REQUIRED_CHECK): Ci {
  if (checks.length === 0)
    return { state: 'none', text: `— (no checks recorded on ${head})`, head }
  const state = ciOfRuns(checks.map(runOfRollupCheck), requiredCheck)
  if (state === 'pending')
    return { state, text: `${pendingText(checks, requiredCheck)} on ${head}`, head }
  const required = checks.find(check => check.name === requiredCheck)
  if (state === 'red') {
    const failing = checks.filter(check => check === required || isFailingOutcome(check))
    return { state, text: `red (${failing.map(check => check.name ?? '?').join(', ')}) on ${head}`, head }
  }
  const at = required?.completedAt
  return at === undefined
    ? { state, text: `green on ${head}`, head }
    : { state, text: `green ${at} on ${head}`, head, greenAt: at }
}

export function shortHead(head: string): string {
  return head.slice(0, SHORT_HEAD_LENGTH)
}

export function detailsOfPullRequestView(view: PullRequestView, knownHead: string): PrDetails {
  return { ci: ciOfRollup(view.statusCheckRollup ?? [], shortHead(view.headRefOid ?? knownHead)), files: view.files?.map(file => file.path) }
}

export function unreadPullRequest(reason: string, knownHead: string): PrDetails {
  return { ci: { state: 'unknown', text: `UNKNOWN (missing: checks; ${reason})`, head: shortHead(knownHead) }, files: undefined }
}

export function pullRequestViewArgs(pr: number, repository: string): string[] {
  return ['pr', 'view', String(pr), '-R', repository, '--json', 'headRefOid,statusCheckRollup,files']
}

export function successfulRunsOnMainArgs(limit: number): string[] {
  return ['run', 'list', '--workflow', 'CI', '--branch', 'main', '--event', 'push', '--status', 'success', '--limit', String(limit), '--json', 'databaseId,headSha']
}

export function jobsOfRunArgs(runId: number): string[] {
  return ['run', 'view', String(runId), '--json', 'jobs']
}

export function artifactsOfRunArgs(run: RunIdentity, name: string): string[] {
  return ['api', `repos/${run.repository}/actions/runs/${run.runId}/artifacts?name=${name}`]
}

export function artifactDownloadArgs(runId: string | number, artifact: ArtifactRequest): string[] {
  const repository = artifact.repository === undefined ? [] : ['--repo', artifact.repository]
  return ['run', 'download', String(runId), ...repository, '--name', artifact.name, '--dir', artifact.dir]
}

export function runCancelArgs(run: RunIdentity): string[] {
  return ['run', 'cancel', run.runId, '--repo', run.repository]
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

export function failedJobLog(run: CiCommand, head: string): FailedJobLog | null {
  const runs = run(['run', 'list', '--commit', head, '--status', 'failure', '--json', 'databaseId', '--limit', '1'])
  if (runs.kind !== 'ran')
    return null
  try {
    const [failed] = JSON.parse(runs.stdout) as { databaseId: number }[]
    if (failed === undefined)
      return null
    const log = run(['run', 'view', String(failed.databaseId), '--log-failed'])
    if (log.kind !== 'ran')
      return null
    const jobs = run(jobsOfRunArgs(failed.databaseId))
    return { log: log.stdout, jobLink: jobs.kind === 'ran' ? failedJobLinkIn(jobs.stdout) : null }
  }
  catch {
    return null
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

export function isTime(value: unknown): boolean {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value))
}

function isListOfObjects(value: unknown): boolean {
  return Array.isArray(value) && value.every(item => item != null && typeof item === 'object' && !Array.isArray(item))
}

export function rollupFault(entry: { statusCheckRollup?: unknown }, index: number): string | undefined {
  if (entry.statusCheckRollup != null && !isListOfObjects(entry.statusCheckRollup))
    return `entry ${index + 1} has a statusCheckRollup that is not a list of checks`
  return undefined
}

export function rollupFields(entry: { statusCheckRollup?: BoardCheck[] | null }): { statusCheckRollup: BoardCheck[] } {
  return { statusCheckRollup: entry.statusCheckRollup ?? [] }
}

function isFailing(check: BoardCheck): boolean {
  if (check.context !== undefined)
    return FAILING_STATES.includes(check.state ?? '')
  return check.status === 'COMPLETED' && !PASSING_OUTCOMES.includes(check.conclusion ?? '')
}

function isFinished(check: BoardCheck): boolean {
  if (check.context !== undefined)
    return !UNFINISHED_STATES.includes(check.state ?? '')
  return check.status === 'COMPLETED'
}

function latestCompletion(checks: readonly BoardCheck[]): string | undefined {
  const times = checks.map(check => check.completedAt).filter((time): time is string => isTime(time))
  return times.length === 0 ? undefined : times.reduce((latest, time) => Date.parse(time) > Date.parse(latest) ? time : latest)
}

export function ciOfChecks(checks: readonly BoardCheck[]): BoardCi {
  const completedAt = latestCompletion(checks)
  if (checks.length === 0)
    return { state: 'none', completedAt }
  if (checks.some(isFailing))
    return { state: 'red', completedAt }
  return { state: checks.every(isFinished) ? 'green' : 'pending', completedAt }
}

export function ciOfPullRequest(pr: { statusCheckRollup: readonly BoardCheck[] }): BoardCi {
  return ciOfChecks(pr.statusCheckRollup)
}
