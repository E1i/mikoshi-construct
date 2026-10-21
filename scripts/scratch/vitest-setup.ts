import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { RUN_ROOT_VARIABLE, RunRoot } from './run-root.js'

export const GH_CREDENTIAL_VARIABLES = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'] as const

export function isolateFromGitHub(env: NodeJS.ProcessEnv = process.env): () => void {
  const configDir = mkdtempSync(path.join(os.tmpdir(), 'gh-config-'))
  env.GH_CONFIG_DIR = configDir
  for (const name of GH_CREDENTIAL_VARIABLES)
    delete env[name]
  return () => rmSync(configDir, { recursive: true, force: true })
}

export default function setup(): () => void {
  const releaseGitHub = isolateFromGitHub()
  if (process.env[RUN_ROOT_VARIABLE] !== undefined)
    return releaseGitHub
  const root = RunRoot.open()
  return () => {
    root.close()
    releaseGitHub()
  }
}
