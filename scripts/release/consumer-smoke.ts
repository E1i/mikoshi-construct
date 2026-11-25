import type { SpawnSyncReturns } from 'node:child_process'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

export const SMOKE_STATUS_CONTEXT = 'construct/consumer-smoke'

export const SMOKE_ROLES = ['launch', 'answer', 'review', 'window'] as const

export type SmokeRole = typeof SMOKE_ROLES[number]

export const CLAIMED_CAPABILITIES = ['browser-lab', 'codex', 'gh', 'git-commit'] as const

export const CARD_SESSION_CAPABILITIES = ['git-push', 'pull-request'] as const

export type SmokeCapability = typeof CLAIMED_CAPABILITIES[number] | typeof CARD_SESSION_CAPABILITIES[number]

export const CARD_SESSION_ROLE: SmokeRole = 'launch'

const STATUS_DESCRIPTION_LIMIT = 140

const SHORT_HEAD = 12

const SESSION_TIMEOUT_MS = 20 * 60 * 1000

const TRANSCRIPT_BUFFER = 64 * 1024 * 1024

const SHOT_DIRECTORY = 'smoke-shots'

export interface SmokeSetting {
  head: string
  browserLab: string
  url: string
  ghRepo: string
}

export interface SmokeStep {
  role: SmokeRole
  capability: SmokeCapability
  command: string
}

export interface StepRecord extends SmokeStep {
  exit: number | null
  output: string
}

export interface SmokeVerdict {
  passed: boolean
  lines: string[]
}

export interface SmokeRun {
  head: string
  records: StepRecord[]
  verdict: SmokeVerdict
}

export interface SmokeStatus {
  state: 'success' | 'failure'
  context: string
  description: string
}

export interface RoleSession {
  run: (role: SmokeRole, steps: SmokeStep[]) => StepRecord[]
}

function shortHead(head: string): string {
  return head.slice(0, SHORT_HEAD)
}

export function cardBranchOf(head: string, role: SmokeRole): string {
  return `smoke/${shortHead(head)}/${role}`
}

export function baseBranchOf(head: string): string {
  return `smoke/${shortHead(head)}/base`
}

const FIRST_STEP: Record<SmokeCapability, (role: SmokeRole, setting: SmokeSetting) => string> = {
  'browser-lab': (role, setting) => `${setting.browserLab} page ${setting.url} --shot ${SHOT_DIRECTORY}/${role}.png`,
  'codex': () => `codex exec 'Reply with the single word ok.'`,
  'gh': (_, setting) => `gh repo view ${setting.ghRepo} --json name`,
  'git-commit': role => `git commit --allow-empty -m 'consumer smoke: ${role}'`,
  'git-push': (role, setting) => `git push -u origin ${cardBranchOf(setting.head, role)}`,
  'pull-request': (role, setting) => `gh pr create --repo ${setting.ghRepo} --base ${baseBranchOf(setting.head)} --head ${cardBranchOf(setting.head, role)} --title 'consumer smoke ${shortHead(setting.head)}' --body 'consumer smoke: the card session commits and opens a pull request'`,
}

function capabilitiesOf(role: SmokeRole): SmokeCapability[] {
  return role === CARD_SESSION_ROLE ? [...CLAIMED_CAPABILITIES, ...CARD_SESSION_CAPABILITIES] : [...CLAIMED_CAPABILITIES]
}

export function smokePlan(setting: SmokeSetting): SmokeStep[] {
  if (!path.isAbsolute(setting.browserLab))
    throw new Error(`browser-lab must be the installed absolute path, not ${setting.browserLab}`)
  return SMOKE_ROLES.flatMap(role => capabilitiesOf(role).map(capability => ({ role, capability, command: FIRST_STEP[capability](role, setting) })))
}

function firstLine(output: string): string {
  return output.split('\n').map(line => line.trim()).find(line => line.length > 0) ?? 'no output'
}

function outcomeOf(record: StepRecord): string {
  return record.exit === null ? 'did not run' : `exited ${record.exit}`
}

export function smokeVerdict(records: StepRecord[]): SmokeVerdict {
  const failed = records.filter(record => record.exit !== 0)
  if (failed.length === 0)
    return { passed: true, lines: [`consumer smoke green: ${records.length} steps across ${SMOKE_ROLES.join(', ')} exited 0.`] }
  return {
    passed: false,
    lines: [
      `consumer smoke red: ${failed.length} of ${records.length} steps failed; each line names the role and the capability to fix.`,
      ...failed.map(record => `  ${record.role}: ${record.capability} ${outcomeOf(record)} — ${firstLine(record.output)} (${record.command})`),
    ],
  }
}

function recordOf(step: SmokeStep, records: StepRecord[]): StepRecord {
  return records.find(record => record.role === step.role && record.capability === step.capability) ?? { ...step, exit: null, output: 'the session returned no record of this step' }
}

export function runSmoke(head: string, plan: SmokeStep[], session: RoleSession): SmokeRun {
  const records = SMOKE_ROLES.flatMap((role) => {
    const steps = plan.filter(step => step.role === role)
    if (steps.length === 0)
      return []
    const returned = session.run(role, steps)
    return steps.map(step => recordOf(step, returned))
  })
  return { head, records, verdict: smokeVerdict(records) }
}

export function smokeStatus(run: SmokeRun): SmokeStatus {
  const failed = run.records.filter(record => record.exit !== 0).map(record => `${record.role} ${record.capability}`)
  const description = failed.length === 0 ? `${run.records.length} steps green in ${SMOKE_ROLES.join(', ')}` : `red: ${failed.join(', ')}`
  return { state: failed.length === 0 ? 'success' : 'failure', context: SMOKE_STATUS_CONTEXT, description: description.slice(0, STATUS_DESCRIPTION_LIMIT) }
}

interface ToolUse {
  id: string
  command: string
}

interface ToolResult {
  text: string
  isError: boolean
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function contentOf(message: unknown): unknown[] {
  return isObject(message) && isObject(message.message) && Array.isArray(message.message.content) ? message.message.content : []
}

function textOf(content: unknown): string {
  if (typeof content === 'string')
    return content
  if (Array.isArray(content))
    return content.map(part => isObject(part) && typeof part.text === 'string' ? part.text : '').join('\n')
  return ''
}

function parsedLines(transcript: string): unknown[] {
  return transcript.split('\n').flatMap((line) => {
    try {
      return [JSON.parse(line) as unknown]
    }
    catch {
      return []
    }
  })
}

function toolUsesOf(events: unknown[]): ToolUse[] {
  return events.flatMap(contentOf).flatMap((part) => {
    if (!isObject(part) || part.type !== 'tool_use' || part.name !== 'Bash' || typeof part.id !== 'string' || !isObject(part.input) || typeof part.input.command !== 'string')
      return []
    return [{ id: part.id, command: part.input.command.trim() }]
  })
}

function toolResultsOf(events: unknown[]): Map<string, ToolResult> {
  const results = new Map<string, ToolResult>()
  for (const part of events.flatMap(contentOf)) {
    if (isObject(part) && part.type === 'tool_result' && typeof part.tool_use_id === 'string')
      results.set(part.tool_use_id, { text: textOf(part.content), isError: part.is_error === true })
  }
  return results
}

const EXIT_CODE = /Exit code (\d+)/

function exitOf(result: ToolResult): number | null {
  if (!result.isError)
    return 0
  const code = EXIT_CODE.exec(result.text)?.[1]
  return code === undefined ? null : Number(code)
}

export function recordsOfTranscript(steps: SmokeStep[], transcript: string): StepRecord[] {
  const events = parsedLines(transcript)
  const uses = toolUsesOf(events)
  const results = toolResultsOf(events)
  return steps.map((step) => {
    const use = uses.find(candidate => candidate.command === step.command.trim())
    if (use === undefined)
      return { ...step, exit: null, output: 'the session never ran this command' }
    const result = results.get(use.id)
    if (result === undefined)
      return { ...step, exit: null, output: 'the session ran this command and recorded no result' }
    return { ...step, exit: exitOf(result), output: result.text }
  })
}

export function sessionPrompt(steps: SmokeStep[]): string {
  return [
    'Run each command below with the Bash tool, exactly as written, one call per command, in this order, even when an earlier one fails. Do nothing else.',
    ...steps.map((step, index) => `${index + 1}. ${step.command}`),
  ].join('\n')
}

export function sessionArgs(steps: SmokeStep[], settings: string | null): string[] {
  return ['--permission-mode', 'dontAsk', '--setting-sources', 'project,local', ...(settings === null ? [] : ['--settings', settings]), '--tools', 'Bash', '-p', '--output-format', 'stream-json', '--verbose', sessionPrompt(steps)]
}

type Spawn = (command: string, args: string[], cwd: string) => SpawnSyncReturns<string>

function spawnIn(command: string, args: string[], cwd: string): SpawnSyncReturns<string> {
  return spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: TRANSCRIPT_BUFFER, timeout: SESSION_TIMEOUT_MS })
}

export class ClaudeRoleSession implements RoleSession {
  constructor(
    private readonly treeOf: (role: SmokeRole) => string,
    private readonly settingsOf: (role: SmokeRole) => string | null,
    private readonly spawn: Spawn = spawnIn,
  ) {}

  run(role: SmokeRole, steps: SmokeStep[]): StepRecord[] {
    const ran = this.spawn('claude', sessionArgs(steps, this.settingsOf(role)), this.treeOf(role))
    return recordsOfTranscript(steps, ran.stdout ?? '')
  }
}

function must(command: string, args: string[], cwd: string): void {
  const ran = spawnIn(command, args, cwd)
  if (ran.status !== 0)
    throw new Error(`${command} ${args.join(' ')} failed in ${cwd}: ${ran.stderr || ran.stdout || String(ran.error)}`)
}

interface ConsumerOptions {
  root: string
  remote: string
  construct: string
  preset: string
}

function prepareConsumer(head: string, options: ConsumerOptions): (role: SmokeRole) => string {
  const repo = path.join(options.root, 'consumer')
  must(options.construct, ['init', '--yes', '--preset', options.preset, '--dir', repo], options.root)
  if (!existsSync(path.join(repo, '.git')))
    must('git', ['init', '-b', 'main'], repo)
  must('git', ['add', '-A'], repo)
  must('git', ['commit', '-m', `consumer smoke base for ${shortHead(head)}`], repo)
  must('git', ['remote', 'add', 'origin', options.remote], repo)
  must('git', ['push', 'origin', `HEAD:refs/heads/${baseBranchOf(head)}`], repo)
  const treeOf = (role: SmokeRole): string => path.join(options.root, 'trees', role)
  for (const role of SMOKE_ROLES) {
    must('git', ['worktree', 'add', '-b', cardBranchOf(head, role), treeOf(role), 'HEAD'], repo)
    mkdirSync(path.join(treeOf(role), SHOT_DIRECTORY), { recursive: true })
  }
  return treeOf
}

function settingsReader(directory: string | undefined): (role: SmokeRole) => string | null {
  return (role) => {
    const file = directory === undefined ? null : path.join(directory, `${role}.json`)
    return file !== null && existsSync(file) ? readFileSync(file, 'utf8') : null
  }
}

function postStatus(repo: string, head: string, status: SmokeStatus): void {
  must('gh', ['api', '-X', 'POST', `repos/${repo}/statuses/${head}`, '-f', `state=${status.state}`, '-f', `context=${status.context}`, '-f', `description=${status.description}`], process.cwd())
}

function main(): void {
  const { values } = parseArgs({
    options: {
      'head': { type: 'string' },
      'repo': { type: 'string' },
      'scratch-repo': { type: 'string' },
      'remote': { type: 'string' },
      'browser-lab': { type: 'string' },
      'url': { type: 'string', default: 'https://example.com' },
      'settings-dir': { type: 'string' },
      'construct': { type: 'string', default: 'construct' },
      'preset': { type: 'string', default: 'node-backend' },
      'out': { type: 'string' },
      'no-status': { type: 'boolean', default: false },
    },
  })
  const { head, repo, remote } = values
  const scratchRepo = values['scratch-repo']
  const browserLab = values['browser-lab']
  if (head === undefined || repo === undefined || scratchRepo === undefined || remote === undefined || browserLab === undefined)
    throw new Error('usage: consumer-smoke --head <version PR head sha> --repo <owner/name> --scratch-repo <owner/name> --remote <scratch git url> --browser-lab <installed absolute path> [--settings-dir <dir of <role>.json>] [--url <page>] [--out <file>] [--no-status]')
  const plan = smokePlan({ head, browserLab, url: values.url, ghRepo: scratchRepo })
  const root = mkdtempSync(path.join(tmpdir(), 'consumer-smoke-'))
  const treeOf = prepareConsumer(head, { root, remote, construct: values.construct, preset: values.preset })
  const run = runSmoke(head, plan, new ClaudeRoleSession(treeOf, settingsReader(values['settings-dir'])))
  const out = values.out ?? path.join(root, 'consumer-smoke.json')
  writeFileSync(out, `${JSON.stringify(run, null, 2)}\n`)
  const write = run.verdict.passed ? console.log : console.error
  write([...run.verdict.lines, `record: ${out}`].join('\n'))
  if (!values['no-status'])
    postStatus(repo, head, smokeStatus(run))
  process.exitCode = run.verdict.passed ? 0 : 1
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  main()
