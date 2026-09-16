import type { ExistingFiles } from './report.js'
import { existsSync, readdirSync } from 'node:fs'
import path from 'node:path'

const ESLINT_CONFIGS = ['eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts', '.eslintrc', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json', '.eslintrc.yml']
const OPENAPI_CANDIDATES = ['contracts/api/openapi.yaml', 'contracts/api/openapi.yml', 'contracts/openapi.yaml', 'openapi.yaml', 'openapi.yml', 'openapi.json', 'api/openapi.yaml', 'docs/openapi.yaml']

function anyExists(dir: string, candidates: string[]): boolean {
  return candidates.some(candidate => existsSync(path.join(dir, candidate)))
}

function firstExisting(dir: string, candidates: string[]): string | null {
  return candidates.find(candidate => existsSync(path.join(dir, candidate))) ?? null
}

function hasWorkflows(dir: string): boolean {
  const workflows = path.join(dir, '.github', 'workflows')
  return existsSync(workflows) && readdirSync(workflows).some(file => file.endsWith('.yml') || file.endsWith('.yaml'))
}

export function detectExisting(dir: string): ExistingFiles {
  return {
    packageJson: existsSync(path.join(dir, 'package.json')),
    tsconfig: existsSync(path.join(dir, 'tsconfig.json')),
    eslintConfig: anyExists(dir, ESLINT_CONFIGS),
    githubWorkflows: hasWorkflows(dir),
    claudeMd: existsSync(path.join(dir, 'CLAUDE.md')),
    agentsMd: existsSync(path.join(dir, 'AGENTS.md')),
    cursorRules: existsSync(path.join(dir, '.cursor', 'rules')),
    openapi: firstExisting(dir, OPENAPI_CANDIDATES),
    constructJson: existsSync(path.join(dir, 'construct.json')),
  }
}
