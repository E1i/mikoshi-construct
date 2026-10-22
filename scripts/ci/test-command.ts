import type { VitestReport } from './vitest-report.js'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'

export const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..')
export const RETRY = '--retry=1'
export const PASS_WITH_NO_TESTS = '--passWithNoTests'

export interface VitestRun { status: number | null, report: VitestReport | null, error: string | null }

export function testScript(root = REPO_ROOT): string[] {
  const { scripts } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> }
  return scripts.test!.split(' ')
}

export function runVitest(args: readonly string[], env: NodeJS.ProcessEnv = process.env, root = REPO_ROOT): VitestRun {
  const dir = mkdtempSync(path.join(tmpdir(), 'prepush-'))
  const report = path.join(dir, 'report.json')
  try {
    const [command, ...script] = testScript(root)
    const run = spawnSync(command!, [...script, ...args, '--reporter=default', '--reporter=json', `--outputFile.json=${report}`], { cwd: root, env, stdio: ['ignore', 'inherit', 'inherit'] })
    return {
      status: run.status,
      report: existsSync(report) ? JSON.parse(readFileSync(report, 'utf8')) as VitestReport : null,
      error: run.error === undefined ? null : run.error.message,
    }
  }
  finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
