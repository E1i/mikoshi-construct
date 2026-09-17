import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { runsHarnessCommand } from './harness.js'

export interface HookFacts {
  manager: string | null
  script: string | null
  runsHarness: boolean
}

const LEFTHOOK_FILES = ['lefthook.yml', 'lefthook.yaml', 'lefthook.toml', 'lefthook.json', '.lefthook.yml', '.lefthook.yaml']
const SIMPLE_GIT_HOOKS_FILES = ['.simple-git-hooks.js', '.simple-git-hooks.cjs', '.simple-git-hooks.mjs', '.simple-git-hooks.json', 'simple-git-hooks.json']
const HUSKY_DIR = '.husky'
const GIT_CONFIG = '.git/config'
const HOOK_SCRIPTS = ['precommit', 'pre-commit', 'prepush', 'pre-push']

function read(root: string, file: string): string | null {
  try {
    return readFileSync(path.join(root, file), 'utf8')
  }
  catch {
    return null
  }
}

function huskyHooks(root: string): string[] {
  const directory = path.join(root, HUSKY_DIR)
  if (!existsSync(directory) || !statSync(directory).isDirectory())
    return []
  return readdirSync(directory)
    .filter(entry => !entry.startsWith('_') && !entry.startsWith('.'))
    .sort()
    .map(entry => `${HUSKY_DIR}/${entry}`)
}

function managerFiles(root: string, packageJson: Record<string, unknown> | null): string[] {
  const files = [...huskyHooks(root)]
  files.push(...[...LEFTHOOK_FILES, ...SIMPLE_GIT_HOOKS_FILES].filter(file => existsSync(path.join(root, file))))
  if (packageJson != null && 'simple-git-hooks' in packageJson)
    files.push('package.json (simple-git-hooks)')
  const gitConfig = read(root, GIT_CONFIG)
  if (gitConfig != null && gitConfig.includes('hooksPath'))
    files.push(`${GIT_CONFIG} (core.hooksPath)`)
  return files
}

export function readHookFacts(root: string, packageJson: Record<string, unknown> | null, scripts: Record<string, string>, commandForms: string[]): HookFacts {
  const files = managerFiles(root, packageJson)
  const script = HOOK_SCRIPTS.find(name => scripts[name] != null) ?? null
  const sources = files.map((file) => {
    if (file.startsWith('package.json'))
      return JSON.stringify(packageJson?.['simple-git-hooks'] ?? '')
    return read(root, file.split(' ')[0]) ?? ''
  })
  const manager = files[0] ?? null
  const scriptRunsHarness = script != null && runsHarnessCommand(scripts[script] ?? '', commandForms)
  const installed = sources.some(source => runsHarnessCommand(source, commandForms) || (scriptRunsHarness && script != null && source.includes(script)))
  return { manager, script, runsHarness: manager != null && installed }
}
