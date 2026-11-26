import type { SpawnSyncReturns } from 'node:child_process'
import type { ClientAdapter, Invocation, Refusal, SessionPolicy, SessionSpec } from '../ports/client/contract.js'
import type { GhPort } from '../ports/gh.js'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { readShiftGate } from '../../src/manifest.js'
import { clientHome, transcriptFile } from '../ports/client/claude/adapter.js'
import { codexAdapter } from '../ports/client/codex/adapter.js'
import { answerPolicy, launchPolicy } from '../ports/client/role-policy.js'
import { PROCESS_GH_PORT } from '../ports/gh.js'
import { clientAdapter } from '../ports/session.js'
import { shellWord } from '../ports/tree-publish.js'
import { SMOKE_STATUS_CONTEXT } from './version-pr-guard.js'

export const SMOKE_ROLES = ['launch', 'answer', 'review', 'window'] as const

export type SmokeRole = typeof SMOKE_ROLES[number]

export const CLAIMED_CAPABILITIES = ['browser-lab', 'codex-exec', 'gh-read', 'git-commit'] as const

export const CARD_SESSION_CAPABILITIES = ['git-push', 'pull-request'] as const

export type SmokeCapability = typeof CLAIMED_CAPABILITIES[number] | typeof CARD_SESSION_CAPABILITIES[number]

export const CARD_SESSION_ROLE: SmokeRole = 'launch'

export const STATUS_DESCRIPTION_LIMIT = 140

const SHORT_HEAD = 12

const SESSION_TIMEOUT_MS = 20 * 60 * 1000

const TRANSCRIPT_BUFFER = 64 * 1024 * 1024

const SHOT_DIRECTORY = 'smoke-shots'

const PRINT_FLAG = '-p'

const SECOND_CLIENT_PROMPT = 'Reply with the single word ok.'

const BARE_WORD = /^[\w./=:@-]+$/

export interface SmokeSetting {
  head: string
  browserLab: string
  url: string
  ghRepo: string
  secondClient: (role: SmokeRole) => string
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
  'codex-exec': (role, setting) => setting.secondClient(role),
  'gh-read': (_, setting) => `gh repo view ${setting.ghRepo} --json name`,
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

function failedRecords(records: readonly StepRecord[]): StepRecord[] {
  return records.filter(record => record.exit !== 0)
}

export function smokeVerdict(records: StepRecord[]): SmokeVerdict {
  const failed = failedRecords(records)
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
  const failed = failedRecords(run.records).map(record => `${record.role} ${record.capability}`)
  const passed = failed.length === 0 && run.records.length > 0
  const description = passed ? `${run.records.length} steps green in ${SMOKE_ROLES.join(', ')}` : `red: ${failed.join(', ') || 'no step ran'}`
  return { state: passed ? 'success' : 'failure', context: SMOKE_STATUS_CONTEXT, description: description.slice(0, STATUS_DESCRIPTION_LIMIT) }
}

interface ToolCall {
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

function toolCallsOf(events: unknown[]): ToolCall[] {
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
  const calls = toolCallsOf(events)
  const results = toolResultsOf(events)
  return steps.map((step) => {
    const call = calls.find(candidate => candidate.command === step.command.trim())
    if (call === undefined)
      return { ...step, exit: null, output: 'the session never ran this command' }
    const result = results.get(call.id)
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

const CLIENT_DEFAULT_POLICY: SessionPolicy = { profile: 'client-default', gateCommands: [], writePaths: [], mcpOff: true }

export function answerOwnerQuestionOf(tree: string): string {
  return path.join(path.dirname(tree), 'answer-owner-question.md')
}

export function productPolicyOf(role: SmokeRole, tree: string): SessionPolicy {
  switch (role) {
    case 'launch':
      return launchPolicy(readShiftGate(tree).prepush)
    case 'answer':
      return answerPolicy(readShiftGate(tree).prepush, [answerOwnerQuestionOf(tree)])
    case 'review':
    case 'window':
      return CLIENT_DEFAULT_POLICY
  }
}

export type PolicyOf = (role: SmokeRole, tree: string) => SessionPolicy

export function smokeSessionSpec(role: SmokeRole, cwd: string, session: string, prompt: string, policyOf: PolicyOf = productPolicyOf): SessionSpec {
  return { kind: 'start', role, session, cwd, prompt, addDirs: [], pick: { model: null }, policy: policyOf(role, cwd) }
}

export function headlessArgs(invocation: Invocation): string[] {
  return invocation.stdin !== null || invocation.args.includes(PRINT_FLAG) ? invocation.args : [...invocation.args, PRINT_FLAG]
}

export type SessionSpawn = (invocation: Invocation, args: string[], cwd: string) => SpawnSyncReturns<string>

function spawnInvocation(invocation: Invocation, args: string[], cwd: string): SpawnSyncReturns<string> {
  return spawnSync(invocation.command, args, { cwd, env: { ...process.env, ...invocation.env }, input: invocation.stdin ?? undefined, encoding: 'utf8', maxBuffer: TRANSCRIPT_BUFFER, timeout: SESSION_TIMEOUT_MS })
}

function sessionTranscript(cwd: string, session: string): string {
  const file = transcriptFile(clientHome(process.env), cwd, session)
  return file !== null && existsSync(file) ? readFileSync(file, 'utf8') : ''
}

export interface AdapterSessionParts {
  treeOf: (role: SmokeRole) => string
  policyOf: PolicyOf
  invocationOf: (spec: SessionSpec) => Invocation | Refusal
  spawn: SessionSpawn
  transcriptOf: (cwd: string, session: string) => string
  sessionId: () => string
}

export class AdapterRoleSession implements RoleSession {
  private readonly parts: AdapterSessionParts

  constructor(treeOf: (role: SmokeRole) => string, parts: Partial<Omit<AdapterSessionParts, 'treeOf'>> = {}) {
    this.parts = { treeOf, policyOf: productPolicyOf, invocationOf: spec => clientAdapter().invocation(spec), spawn: spawnInvocation, transcriptOf: sessionTranscript, sessionId: randomUUID, ...parts }
  }

  run(role: SmokeRole, steps: SmokeStep[]): StepRecord[] {
    const cwd = this.parts.treeOf(role)
    const session = this.parts.sessionId()
    const invocation = this.parts.invocationOf(smokeSessionSpec(role, cwd, session, sessionPrompt(steps), this.parts.policyOf))
    if ('kind' in invocation)
      return steps.map(step => ({ ...step, exit: null, output: `the client refused the ${role} session: ${invocation.reason}` }))
    const ran = this.parts.spawn(invocation, headlessArgs(invocation), cwd)
    return recordsOfTranscript(steps, `${ran.stdout ?? ''}\n${this.parts.transcriptOf(cwd, session)}`)
  }
}

function commandWord(word: string): string {
  return BARE_WORD.test(word) ? word : shellWord(word)
}

export function secondClientStep(adapter: ClientAdapter, treeOf: (role: SmokeRole) => string): (role: SmokeRole) => string {
  return (role) => {
    const invocation = adapter.invocation({ kind: 'start', role: 'review', session: '', cwd: treeOf(role), prompt: SECOND_CLIENT_PROMPT, addDirs: [], pick: { model: null }, policy: { profile: 'sandboxed', gateCommands: [], writePaths: [], mcpOff: false } })
    if ('kind' in invocation)
      throw new Error(`the second client refused its first step: ${invocation.reason}`)
    return [invocation.command, ...invocation.args].map(commandWord).join(' ')
  }
}

export function postSmokeStatus(repo: string, head: string, status: SmokeStatus, port: GhPort = PROCESS_GH_PORT): void {
  const posted = port.call(['api', '--method', 'POST', `repos/${repo}/statuses/${head}`, '-f', `state=${status.state}`, '-f', `context=${status.context}`, '-f', `description=${status.description.slice(0, STATUS_DESCRIPTION_LIMIT)}`])
  if (posted.kind === 'failed')
    throw new Error(`the consumer smoke status was not posted on ${head}: ${posted.reason}`)
}

function must(command: string, args: string[], cwd: string): void {
  const ran = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: TRANSCRIPT_BUFFER, timeout: SESSION_TIMEOUT_MS })
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

function main(): void {
  const { values } = parseArgs({
    options: {
      'head': { type: 'string' },
      'repo': { type: 'string' },
      'scratch-repo': { type: 'string' },
      'remote': { type: 'string' },
      'browser-lab': { type: 'string' },
      'url': { type: 'string', default: 'https://example.com' },
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
    throw new Error('usage: consumer-smoke --head <version PR head sha> --repo <owner/name> --scratch-repo <owner/name> --remote <scratch git url> --browser-lab <installed absolute path> [--url <page>] [--out <file>] [--no-status]')
  const root = mkdtempSync(path.join(tmpdir(), 'consumer-smoke-'))
  const treeOf = prepareConsumer(head, { root, remote, construct: values.construct, preset: values.preset })
  const plan = smokePlan({ head, browserLab, url: values.url, ghRepo: scratchRepo, secondClient: secondClientStep(codexAdapter, treeOf) })
  const run = runSmoke(head, plan, new AdapterRoleSession(treeOf))
  const out = values.out ?? path.join(root, 'consumer-smoke.json')
  writeFileSync(out, `${JSON.stringify(run, null, 2)}\n`)
  const write = run.verdict.passed ? console.log : console.error
  write([...run.verdict.lines, `record: ${out}`].join('\n'))
  if (!values['no-status'])
    postSmokeStatus(repo, head, smokeStatus(run))
  process.exitCode = run.verdict.passed ? 0 : 1
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  main()
