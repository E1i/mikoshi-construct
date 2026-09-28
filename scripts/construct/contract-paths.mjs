import { existsSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const CONTRACT_PATHS_LINE = /^Contract paths:(.*)$/m

export function manifestContractPaths(manifest) {
  const contracts = manifest?.contracts
  if (contracts == null)
    return []
  return [contracts.path, contracts.types].filter(entry => typeof entry === 'string' && entry !== '')
}

export function agentsContractPaths(agentsText, claudeText) {
  const found = CONTRACT_PATHS_LINE.exec(agentsText ?? '')
  if (found != null)
    return found[1].split(',').map(entry => entry.trim()).filter(entry => entry !== '')
  const foundInClaude = CONTRACT_PATHS_LINE.exec(claudeText ?? '')
  if (foundInClaude != null)
    throw new Error(`${foundInClaude[0].trim()}\nmoved to AGENTS.md`)
  return []
}

function readIfPresent(file) {
  return existsSync(file) ? readFileSync(file, 'utf8') : null
}

export function contractPaths(root) {
  const manifest = readIfPresent(path.join(root, 'construct.json'))
  const agents = readIfPresent(path.join(root, 'AGENTS.md'))
  const claude = readIfPresent(path.join(root, 'CLAUDE.md'))
  const paths = [
    ...(manifest == null ? [] : manifestContractPaths(JSON.parse(manifest))),
    ...agentsContractPaths(agents, claude),
  ]
  return [...new Set(paths)]
}

function isEntry() {
  return process.argv[1] != null && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
}

if (isEntry()) {
  try {
    process.stdout.write(`${JSON.stringify(contractPaths(process.cwd()))}\n`)
  }
  catch (error) {
    process.stderr.write(`${error.message}\n`)
    process.exitCode = 1
  }
}
