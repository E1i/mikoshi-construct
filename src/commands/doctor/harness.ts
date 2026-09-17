import type { Manifest } from '../../manifest.js'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

export interface HarnessFacts {
  command: string
  script: string
  scripts: Record<string, string>
  body: string | null
  resolved: string
  commandForms: string[]
  packageJson: Record<string, unknown> | null
}

const REQUIRED_QUALITY_STEPS = ['lint', 'typecheck', 'test']
const SCRIPT_REFERENCE = /(?:^|&&|\|\||;)\s*(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?([\w:.-]+)/g

export function harnessScriptName(command: string): string {
  return command.replace(/^(pnpm|npm|yarn|bun)\s+(run\s+)?/, '')
}

function expandScript(scripts: Record<string, string>, name: string, seen: Set<string>): string {
  if (seen.has(name))
    return ''
  seen.add(name)
  const body = scripts[name]
  if (body == null)
    return ''
  const referenced = [...body.matchAll(SCRIPT_REFERENCE)].map(match => match[1])
  return [body, ...referenced.map(reference => expandScript(scripts, reference, seen))].join(' && ')
}

export function readHarnessFacts(root: string, command: string): HarnessFacts {
  const script = harnessScriptName(command)
  const manifestPath = path.join(root, 'package.json')
  const packageJson = existsSync(manifestPath)
    ? JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
    : null
  const scripts = (packageJson?.scripts ?? {}) as Record<string, string>
  const body = scripts[script] ?? null
  return {
    command,
    script,
    scripts,
    body,
    resolved: expandScript(scripts, script, new Set()),
    commandForms: [command, `pnpm run ${script}`, `pnpm ${script}`, `npm run ${script}`, `yarn ${script}`],
    packageJson,
  }
}

export function runsHarnessCommand(text: string, forms: string[]): boolean {
  return forms.some(form => text.includes(form))
}

function contractProblems(root: string, contracts: Manifest['contracts'], script: string, body: string): string[] {
  if (contracts == null)
    return []
  const problems = [contracts.path, contracts.types]
    .filter(file => !existsSync(path.join(root, file)))
    .map(file => `${file} is missing (construct.json → contracts)`)
  if (!body.includes('contracts:check'))
    problems.push(`"${script}" does not run contracts:check`)
  return problems
}

export function harnessProblems(root: string, manifest: Manifest, facts: HarnessFacts): string[] {
  if (facts.packageJson == null)
    return ['package.json is missing']
  const body = facts.body
  if (body == null)
    return [`package.json has no "${facts.script}" script (harness command is "${facts.command}")`]
  return [
    ...REQUIRED_QUALITY_STEPS.filter(step => !body.includes(step)).map(step => `"${facts.script}" does not run ${step}`),
    ...contractProblems(root, manifest.contracts, facts.script, body),
  ]
}
