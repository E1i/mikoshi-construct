import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

export { unresolvedCommandWord } from '../intake/command-word.js'

const FILE_EDITING = [/\S+:fix(?=\s|$)/, /--fix(?=[\s=]|$)/, /--write(?=[\s=]|$)/]

const PACKAGE_RUNNERS = ['npm run', 'npx']

export function throughPackageRunners(command: string, word: string): string[] {
  const trimmed = command.trim()
  const at = trimmed.split(/(\s+)/).findIndex(token => token === word)
  return PACKAGE_RUNNERS.map(runner => trimmed.split(/(\s+)/).map((token, index) => index === at ? `${runner} ${token}` : token).join(''))
}

export function fileEditingMarks(command: string): string[] {
  return FILE_EDITING.flatMap(pattern => command.match(pattern)?.[0] ?? [])
}

export interface HarnessCandidate {
  command: string
  source: string
  job?: string
}

export const MAX_HARNESS_CANDIDATES = 3

const WORKFLOWS_DIR = '.github/workflows'
const WORKFLOW_FILE = /\.ya?ml$/
const RUN_STEP = /^(\s*)(?:-\s+)?run:(.*)$/
const BLOCK_SCALAR = /^[|>][+-]?\d*\s*(?:#.*)?$/
const PACKAGE_SCRIPT_CALL = /^(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?([\w:.-]+)(?=\s|$)/
const RUNS_TESTS = /test/i
const LINTS = /lint/i
const TYPECHECKS = /type-?check/i
const LOCKFILES: [string, string][] = [['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['bun.lockb', 'bun'], ['bun.lock', 'bun']]

type Rank = 0 | 1

interface Found extends HarnessCandidate {
  reads: string
}

const JOBS_KEY = /^jobs:\s*(?:#.*)?$/
const JOB_ID = /^\s+([\w-]+):\s*(?:#.*)?$/
const JOB_NAME = /^\s+name:[ \t]+([^#\s][^#]*)/

function unquoted(value: string): string {
  const trimmed = value.trim()
  const quoted = /^(['"])(.*)\1$/.exec(trimmed)
  return quoted?.[2] ?? trimmed
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length
}

function jobsOf(lines: string[]): (string | undefined)[] {
  const jobs: (string | undefined)[] = lines.map(() => undefined)
  const start = lines.findIndex(line => JOBS_KEY.test(line))
  if (start < 0)
    return jobs
  const heads: { at: number, id: string }[] = []
  let end = lines.length
  for (let at = start + 1; at < lines.length; at++) {
    if (lines[at].trim() === '')
      continue
    if (indentOf(lines[at]) === 0) {
      end = at
      break
    }
    const id = JOB_ID.exec(lines[at])?.[1]
    if (id != null && (heads.length === 0 || indentOf(lines[at]) === indentOf(lines[heads[0].at])))
      heads.push({ at, id })
  }
  heads.forEach((head, position) => {
    const stop = heads[position + 1]?.at ?? end
    const nameLine = lines.slice(head.at + 1, stop).find(line => indentOf(line) === indentOf(lines[head.at]) + 2 && JOB_NAME.test(line))
    const name = nameLine == null ? head.id : unquoted(JOB_NAME.exec(nameLine)![1])
    for (let at = head.at; at < stop; at++)
      jobs[at] = name
  })
  return jobs
}

function workflowRunLines(file: string, text: string): Found[] {
  const lines = text.split(/\r?\n/)
  const jobs = jobsOf(lines)
  return lines.flatMap((line, index) => {
    const step = RUN_STEP.exec(line)
    if (step == null)
      return []
    const value = step[2].trim()
    if (!BLOCK_SCALAR.test(value))
      return value === '' ? [] : [{ command: unquoted(value), source: `${file}:${index + 1}`, reads: unquoted(value), job: jobs[index] }]
    const indent = step[1].length
    const body: Found[] = []
    for (let at = index + 1; at < lines.length; at++) {
      const next = lines[at]
      if (next.trim() === '')
        continue
      if (next.length - next.trimStart().length <= indent)
        break
      const command = next.trim()
      if (!command.startsWith('#'))
        body.push({ command, source: `${file}:${at + 1}`, reads: command, job: jobs[index] })
    }
    return body
  })
}

function readText(root: string, file: string): string | null {
  try {
    return readFileSync(path.join(root, file), 'utf8')
  }
  catch {
    return null
  }
}

function workflowSteps(root: string): Found[] {
  let entries: string[]
  try {
    entries = readdirSync(path.join(root, WORKFLOWS_DIR)).filter(entry => WORKFLOW_FILE.test(entry)).sort()
  }
  catch {
    return []
  }
  return entries.flatMap((entry) => {
    const file = `${WORKFLOWS_DIR}/${entry}`
    const text = readText(root, file)
    return text == null ? [] : workflowRunLines(file, text)
  })
}

function readScripts(root: string): { scripts: Record<string, string>, packageManager: string | null } {
  const text = readText(root, 'package.json')
  if (text == null)
    return { scripts: {}, packageManager: null }
  try {
    const manifest = JSON.parse(text) as { scripts?: unknown, packageManager?: unknown }
    const scripts = typeof manifest.scripts === 'object' && manifest.scripts != null
      ? Object.fromEntries(Object.entries(manifest.scripts).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
      : {}
    const packageManager = typeof manifest.packageManager === 'string' ? manifest.packageManager.split('@')[0] : null
    return { scripts, packageManager }
  }
  catch {
    return { scripts: {}, packageManager: null }
  }
}

function packageManagerOf(root: string, declared: string | null): string {
  return declared ?? LOCKFILES.find(([lockfile]) => existsSync(path.join(root, lockfile)))?.[1] ?? 'npm'
}

function withScriptBody(found: Found, scripts: Record<string, string>): Found {
  const name = PACKAGE_SCRIPT_CALL.exec(found.command)?.[1]
  const body = name == null ? undefined : scripts[name]
  return body == null ? found : { ...found, reads: `${found.reads} ${name} ${body}` }
}

function rankOf(found: Found): Rank | null {
  if (RUNS_TESTS.test(found.reads))
    return 0
  if (LINTS.test(found.reads))
    return null
  return TYPECHECKS.test(found.reads) ? 1 : null
}

function sameCommand(command: string): string {
  return command.trim().replace(/\s+/g, ' ').replace(/^(pnpm|npm|yarn|bun) run /, '$1 ')
}

export function harnessCandidates(root: string): HarnessCandidate[] {
  const { scripts, packageManager } = readScripts(root)
  const runner = packageManagerOf(root, packageManager)
  const fromCi = workflowSteps(root).map(found => withScriptBody(found, scripts))
  const fromScripts = Object.entries(scripts).map(([name, body]): Found => ({ command: `${runner} run ${name}`, source: `package.json scripts.${name}`, reads: `${name} ${body}` }))
  const ranked = [...fromCi, ...fromScripts]
    .flatMap((found) => {
      const rank = rankOf(found)
      return rank == null ? [] : [{ found, rank }]
    })
    .sort((a, b) => a.rank - b.rank)
  const seen = new Set<string>()
  const candidates: HarnessCandidate[] = []
  for (const { found } of ranked) {
    const key = sameCommand(found.command)
    if (seen.has(key))
      continue
    seen.add(key)
    candidates.push(found.job == null ? { command: found.command, source: found.source } : { command: found.command, source: found.source, job: found.job })
  }
  return candidates.slice(0, MAX_HARNESS_CANDIDATES)
}
