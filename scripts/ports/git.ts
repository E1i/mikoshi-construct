import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'

export const TECHNOLOGY_WORDS = ['exec', 'git', 'porcelain'] as const

export interface WorktreeEntry {
  path: string
  branch: string | undefined
}

export interface GitReader {
  dirty: (worktree: string) => number | undefined
  worktrees: (repoRoot: string) => WorktreeEntry[] | undefined
}

export interface GitRunner {
  read: (tree: string, args: readonly string[]) => string
  readBytes: (tree: string, args: readonly string[], maxBuffer: number) => Buffer
  succeeds: (tree: string, args: readonly string[]) => boolean
}

export type GitAnswer = string | Buffer | Error

export interface GitCall {
  tree: string
  args: string[]
}

function run(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

export const processGit: GitRunner = {
  read(tree, args) {
    return run(['-C', tree, ...args])
  },
  readBytes(tree, args, maxBuffer) {
    return execFileSync('git', ['-C', tree, ...args], { stdio: ['ignore', 'pipe', 'pipe'], maxBuffer })
  },
  succeeds(tree, args) {
    try {
      run(['-C', tree, ...args])
      return true
    }
    catch {
      return false
    }
  },
}

export class InMemoryGit implements GitRunner {
  readonly calls: GitCall[] = []

  constructor(private readonly answer: (call: GitCall) => GitAnswer) {}

  read(tree: string, args: readonly string[]): string {
    const answered = this.answered(tree, args)
    return typeof answered === 'string' ? answered : answered.toString('utf8')
  }

  readBytes(tree: string, args: readonly string[]): Buffer {
    const answered = this.answered(tree, args)
    return typeof answered === 'string' ? Buffer.from(answered, 'utf8') : answered
  }

  succeeds(tree: string, args: readonly string[]): boolean {
    try {
      this.answered(tree, args)
      return true
    }
    catch {
      return false
    }
  }

  private answered(tree: string, args: readonly string[]): string | Buffer {
    const call = { tree, args: [...args] }
    this.calls.push(call)
    const answer = this.answer(call)
    if (answer instanceof Error)
      throw answer
    return answer
  }
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
