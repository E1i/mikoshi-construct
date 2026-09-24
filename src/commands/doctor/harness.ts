import type { Manifest } from '../../manifest.js'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { FileReadings } from './readings.js'

export interface HarnessFacts {
  command: string
  script: string | null
  body: string | null
  resolved: string
  packageJson: Record<string, unknown> | null
}

const SCRIPT_REFERENCE = /(?:^|&&|\|\||;)\s*(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?([\w:.-]+)/g
const PACKAGE_SCRIPT_COMMAND = /^(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?([\w:.-]+)$/

export type HarnessState = 'checked' | 'unknown'

export interface HarnessReading {
  command: string
  state: HarnessState
}

function packageScriptOf(command: string): string | null {
  return PACKAGE_SCRIPT_COMMAND.exec(command.trim())?.[1] ?? null
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
  const script = packageScriptOf(command)
  if (script == null)
    return { command, script, body: null, resolved: '', packageJson: null }
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

export function harnessReading(facts: HarnessFacts): HarnessReading {
  return { command: facts.command, state: facts.script == null ? 'unknown' : 'checked' }
}

export function harnessProblems(root: string, manifest: Manifest, facts: HarnessFacts, readings: FileReadings = new FileReadings(root)): string[] {
  if (facts.script == null)
    return missingContractFiles(root, manifest.contracts)
  if (facts.packageJson == null)
    return readings.unreadable(HARNESS_MANIFEST) ? [] : [`${HARNESS_MANIFEST} is missing`]
  if (facts.body == null)
    return [`package.json has no "${facts.script}" script (harness command is "${facts.command}")`]
  return missingContractFiles(root, manifest.contracts)
}
