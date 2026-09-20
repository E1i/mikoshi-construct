import type { Manifest } from '../../manifest.js'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { FileReadings } from './readings.js'

export interface HarnessFacts {
  command: string
  script: string
  body: string | null
  resolved: string
  packageJson: Record<string, unknown> | null
}

const SCRIPT_REFERENCE = /(?:^|&&|\|\||;)\s*(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?([\w:.-]+)/g

function harnessScriptName(command: string): string {
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

export const HARNESS_MANIFEST = 'package.json'

export function readHarnessFacts(root: string, command: string, readings: FileReadings = new FileReadings(root)): HarnessFacts {
  const script = harnessScriptName(command)
  const packageJson = readings.readJson(HARNESS_MANIFEST)
  const scripts = (packageJson?.scripts ?? {}) as Record<string, string>
  const body = scripts[script] ?? null
  return {
    command,
    script,
    body,
    resolved: expandScript(scripts, script, new Set()),
    packageJson,
  }
}

function missingContractFiles(root: string, contracts: Manifest['contracts']): string[] {
  if (contracts == null)
    return []
  return [contracts.path, contracts.types]
    .filter(file => !existsSync(path.join(root, file)))
    .map(file => `${file} is missing (construct.json → contracts)`)
}

export function harnessProblems(root: string, manifest: Manifest, facts: HarnessFacts, readings: FileReadings = new FileReadings(root)): string[] {
  if (facts.packageJson == null)
    return readings.unreadable(HARNESS_MANIFEST) ? [] : [`${HARNESS_MANIFEST} is missing`]
  if (facts.body == null)
    return [`package.json has no "${facts.script}" script (harness command is "${facts.command}")`]
  return missingContractFiles(root, manifest.contracts)
}
