import { execFileSync } from 'node:child_process'

export interface WorktreeEntry {
  path: string
  branch: string | undefined
}

export interface GitReader {
  dirty: (worktree: string) => number | undefined
  worktrees: (repoRoot: string) => WorktreeEntry[] | undefined
}

function run(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

export function parseWorktrees(porcelain: string): WorktreeEntry[] {
  return porcelain.split('\n\n').filter(block => block.trim() !== '').map((block) => {
    const lines = block.split('\n')
    const branch = lines.find(line => line.startsWith('branch '))?.slice('branch '.length).replace(/^refs\/heads\//, '')
    return { path: lines.find(line => line.startsWith('worktree '))!.slice('worktree '.length), branch }
  })
}

export const execGit: GitReader = {
  dirty(worktree) {
    try {
      return run(['-C', worktree, 'status', '--porcelain']).split('\n').filter(line => line !== '').length
    }
    catch {
      return undefined
    }
  },
  worktrees(repoRoot) {
    try {
      return parseWorktrees(run(['-C', repoRoot, 'worktree', 'list', '--porcelain']))
    }
    catch {
      return undefined
    }
  },
}
