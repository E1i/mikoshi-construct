import type { DiscoveryMarker, Manifest } from '../manifest.js'
import type { Ui } from '../ui/console.js'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { DISCOVERY_MARKERS, readManifest, sha256 } from '../manifest.js'

export interface DoctorResult {
  ok: boolean
  missingFiles: string[]
  modifiedFiles: string[]
  missingDiscovery: DiscoveryMarker[]
  harnessProblems: string[]
}

export const DISCOVERY_PLACEHOLDER = '_Not discovered yet — run `/construct-discover`._'

export function markerOpen(marker: string): string {
  return `<!-- construct:discover:${marker} -->`
}

export function markerClose(marker: string): string {
  return `<!-- /construct:discover:${marker} -->`
}

export function isMarkerFilled(document: string, marker: string): boolean {
  const start = document.indexOf(markerOpen(marker))
  const stop = document.indexOf(markerClose(marker))
  if (start === -1 || stop === -1 || stop < start)
    return false
  const body = document.slice(start + markerOpen(marker).length, stop).trim()
  return body !== '' && body !== DISCOVERY_PLACEHOLDER
}

const REQUIRED_QUALITY_STEPS = ['lint', 'typecheck', 'test']

function contractProblems(root: string, contracts: Manifest['contracts'], scriptName: string, quality: string): string[] {
  if (contracts == null)
    return []
  const problems = [contracts.path, contracts.types]
    .filter(file => !existsSync(path.join(root, file)))
    .map(file => `${file} is missing (construct.json → contracts)`)
  if (!quality.includes('contracts:check'))
    problems.push(`"${scriptName}" does not run contracts:check`)
  return problems
}

function harnessProblems(root: string, manifest: Manifest): string[] {
  const command = manifest.harness.command
  const manifestPath = path.join(root, 'package.json')
  if (!existsSync(manifestPath))
    return ['package.json is missing']
  const pkg = JSON.parse(readFileSync(manifestPath, 'utf8')) as { scripts?: Record<string, string> }
  const scripts = pkg.scripts ?? {}
  const scriptName = command.replace(/^(pnpm|npm|yarn|bun)\s+(run\s+)?/, '')
  const quality = scripts[scriptName]
  if (quality == null)
    return [`package.json has no "${scriptName}" script (harness command is "${command}")`]
  return [
    ...REQUIRED_QUALITY_STEPS.filter(step => !quality.includes(step)).map(step => `"${scriptName}" does not run ${step}`),
    ...contractProblems(root, manifest.contracts, scriptName, quality),
  ]
}

export function runDoctor(root: string): DoctorResult | null {
  const manifest = readManifest(root)
  if (manifest == null)
    return null

  const missingFiles: string[] = []
  const modifiedFiles: string[] = []
  for (const [file, hash] of Object.entries(manifest.files)) {
    const absolute = path.join(root, file)
    if (!existsSync(absolute))
      missingFiles.push(file)
    else if (sha256(readFileSync(absolute, 'utf8')) !== hash)
      modifiedFiles.push(file)
  }

  const missingDiscovery = DISCOVERY_MARKERS.filter((marker) => {
    const location = path.join(root, manifest.discovery[marker])
    if (marker === 'composition')
      return !existsSync(location) || !readdirSync(location).some(file => file.endsWith('.yaml'))
    return !existsSync(location) || !isMarkerFilled(readFileSync(location, 'utf8'), marker)
  })

  const problems = harnessProblems(root, manifest)
  return {
    ok: missingFiles.length === 0 && problems.length === 0,
    missingFiles,
    modifiedFiles,
    missingDiscovery,
    harnessProblems: problems,
  }
}

export function printDoctor(ui: Ui, result: DoctorResult | null): number {
  if (result == null) {
    ui.flatline('No construct.json here. Run `construct init` first.')
    return 1
  }
  if (result.harnessProblems.length > 0)
    ui.glitch('Harness is broken.', result.harnessProblems)
  if (result.missingFiles.length > 0)
    ui.glitch('Baseline files are missing.', result.missingFiles)
  if (result.missingDiscovery.length > 0) {
    ui.glitch(ui.lore.discoveryIncomplete, ['', 'Missing:', ...result.missingDiscovery.map(marker => `  ${marker}`), '', 'Run: claude → /construct-discover'])
  }
  if (result.modifiedFiles.length > 0)
    ui.line(ui.theme.dim(`  ${result.modifiedFiles.length} baseline files modified since init (expected once the project evolves).`))
  if (result.ok) {
    ui.ok(ui.lore.stable)
    return 0
  }
  return 1
}
