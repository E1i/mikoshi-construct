import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'

export interface CommandResult {
  exitCode: number
  stdout: string
  stderr: string
}

export interface Evidence {
  object: string
  verdict: string
  line: string
  lab: string[]
  screenshot: string | null
  console: string | null
  agent: string | null
}

export interface DaemonResult {
  status: string
  run: string
  objects: Evidence[]
  unobserved: string[]
}

export interface AgentOptions {
  label?: string
  schema?: unknown
}

export type Agent = (prompt: string, options?: AgentOptions) => Promise<unknown>

export const REPO_ROOT = path.resolve(import.meta.dirname, '..')
export const CORE = ['scripts/construct/daemon-run.mjs', 'scripts/construct/daemon.mjs', 'scripts/construct/daemon-adapter.schema.json']
const WORKFLOW = 'scripts/construct/daemon.workflow'
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...args: string[]) => (...values: unknown[]) => Promise<DaemonResult>

export function commandOf(prompt: string): string {
  const command = prompt.split('\n').find(line => line.startsWith('node scripts/construct/daemon-run.mjs '))
  if (command == null)
    throw new Error(`no command in the prompt: ${prompt}`)
  return command
}

export function run(root: string, command: string): CommandResult {
  const result = spawnSync(command, { cwd: root, shell: true, encoding: 'utf8' })
  return { exitCode: result.status ?? 1, stdout: result.stdout, stderr: result.stderr }
}

export function evidenceDirectoryOf(prompt: string): string {
  const match = prompt.match(/into (\S+)\/ and nowhere else/)
  if (match?.[1] == null)
    throw new Error(`no evidence directory in the prompt: ${prompt}`)
  return match[1]
}

export async function runWorkflow(args: Record<string, unknown>, agent: Agent): Promise<DaemonResult> {
  const source = readFileSync(path.join(REPO_ROOT, WORKFLOW), 'utf8').replace(/^export const meta = \{[\s\S]+?^\}$/m, '')
  return new AsyncFunction('args', 'agent', 'log', 'phase', source)(args, agent, () => {}, () => {})
}
