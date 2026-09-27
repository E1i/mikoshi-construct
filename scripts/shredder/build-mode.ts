import { spawnSync } from 'node:child_process'
import path from 'node:path'

const CHECK_ACCEPTANCE = path.join(import.meta.dirname, '..', 'construct', 'check-acceptance.mjs')
const REPO_ROOT = path.join(import.meta.dirname, '..', '..')
const NO_ACCEPTANCE_SECTION = 'the brief has no Acceptance: section'

export interface BuildModeResult {
  effort: string | null
  witnessCount: number
  immutable: string[]
  refusal: string | null
}

export function runBuildMode(taskFilePath: string): BuildModeResult {
  const result = spawnSync('node', [CHECK_ACCEPTANCE, 'build', '--brief', taskFilePath], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
  if (result.status === 0) {
    const parsed = JSON.parse(result.stdout) as { effort: string, witnesses: unknown[], immutable: string[] }
    return {
      effort: parsed.effort === '' ? null : parsed.effort,
      witnessCount: parsed.witnesses.length,
      immutable: parsed.immutable,
      refusal: null,
    }
  }
  const message = result.stderr.trim()
  if (message === NO_ACCEPTANCE_SECTION)
    return { effort: null, witnessCount: 0, immutable: [], refusal: null }
  return { effort: null, witnessCount: 0, immutable: [], refusal: message }
}
