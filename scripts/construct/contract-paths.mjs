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

export function claudeContractPaths(text) {
  const line = CONTRACT_PATHS_LINE.exec(text)
  if (line == null)
    return []
  return line[1].split(',').map(entry => entry.trim()).filter(entry => entry !== '')
}

function readIfPresent(file) {
  return existsSync(file) ? readFileSync(file, 'utf8') : null
}

export function contractPaths(root) {
  const manifest = readIfPresent(path.join(root, 'construct.json'))
  const claude = readIfPresent(path.join(root, 'CLAUDE.md'))
  const paths = [
    ...(manifest == null ? [] : manifestContractPaths(JSON.parse(manifest))),
    ...(claude == null ? [] : claudeContractPaths(claude)),
  ]
  return [...new Set(paths)]
}

function isEntry() {
  return process.argv[1] != null && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
}

if (isEntry())
  process.stdout.write(`${JSON.stringify(contractPaths(process.cwd()))}\n`)
