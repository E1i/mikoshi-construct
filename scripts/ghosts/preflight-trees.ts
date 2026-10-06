import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

export interface ShellResult { status: number | null, output: string }
export type Shell = (command: string, cwd: string) => ShellResult

const SHELL_BUFFER = 1 << 28

export function realShell(command: string, cwd: string): ShellResult {
  const result = spawnSync('bash', ['-c', command], { cwd, encoding: 'utf8', maxBuffer: SHELL_BUFFER })
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

export function gitIn(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: SHELL_BUFFER }).trim()
}

export function lastLine(output: string): string {
  const lines = output.split('\n').map(line => line.trim()).filter(line => line !== '')
  return lines.at(-1) ?? 'no output'
}

export function withWorktree<T>(repo: string, base: string, run: (tree: string) => T): T {
  const dir = mkdtempSync(path.join(tmpdir(), 'ghosts-preflight-'))
  const tree = path.join(dir, 'tree')
  gitIn(repo, ['worktree', 'add', '--detach', tree, base])
  try {
    return run(tree)
  }
  finally {
    try {
      gitIn(repo, ['worktree', 'remove', '--force', tree])
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
      gitIn(repo, ['worktree', 'prune'])
    }
  }
}

export function stageSketch(tree: string, base: string, sketchSha: string): void {
  gitIn(tree, ['reset', '--hard', '-q', base])
  gitIn(tree, ['clean', '-fdq'])
  gitIn(tree, ['read-tree', '-m', '-u', base, sketchSha])
}
