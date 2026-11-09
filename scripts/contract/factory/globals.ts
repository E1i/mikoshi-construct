import { existsSync } from 'node:fs'
import path from 'node:path'

export const GLOBALS_VERSION = 1

export interface GlobalsSection {
  globalsVersion: number
  files: Record<string, string>
}

export const GLOBAL_FILES: Readonly<Record<string, string>> = {
  '.npmrc': 'the install settings every dependency is resolved under',
  '.nvmrc': 'the Node version every test runs on',
  'package.json': 'the scripts and dependencies every test runs under',
  'pnpm-lock.yaml': 'the installed dependency tree every module imports from',
  'pnpm-workspace.yaml': 'the workspace and the catalog every dependency range resolves through',
  'tsconfig.base.json': 'the compiler settings every module is checked under',
  'tsconfig.json': 'the compiler settings every module is checked under',
}

export function globalsSection(root: string, files: Readonly<Record<string, string>> = GLOBAL_FILES): GlobalsSection {
  const missing = Object.keys(files).filter(file => !existsSync(path.join(root, file)))
  if (missing.length > 0)
    throw new Error(`a global file of the contract is not in the repository: ${missing.join(', ')}`)
  return { globalsVersion: GLOBALS_VERSION, files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) }
}
