import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { PREFIX } from './loop.js'

export const SANDBOX_UNWRITABLE_PREFIX = '.claude/'
export const UPSTREAM = 'origin/main'

export interface MikoPullDeps {
  git: (args: string[]) => string
  out: (line: string) => void
  err: (line: string) => void
}

export function ownerPullCommand(tree: string): string {
  return `git -C ${tree} pull --ff-only`
}

export function sandboxUnwritable(paths: string[]): string[] {
  return paths.filter(file => file.startsWith(SANDBOX_UNWRITABLE_PREFIX))
}

export function runMikoPull(deps: MikoPullDeps): number {
  deps.git(['fetch', 'origin', 'main'])
  const incoming = deps.git(['diff', '--name-only', 'HEAD', UPSTREAM]).split('\n').filter(line => line !== '')
  const blocked = sandboxUnwritable(incoming)
  if (blocked.length > 0) {
    const tree = deps.git(['rev-parse', '--show-toplevel']).trim()
    deps.err(`${PREFIX}${blocked.length} incoming path(s) under ${SANDBOX_UNWRITABLE_PREFIX} the window's sandbox cannot write (${blocked.join(', ')}), nothing pulled; the owner pulls the main tree: ${ownerPullCommand(tree)}`)
    return 1
  }
  deps.out(deps.git(['pull', '--ff-only']).trimEnd())
  return 0
}

export function realMikoPullDeps(cwd: string): MikoPullDeps {
  return {
    git: args => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }),
    out: line => console.log(line),
    err: line => console.error(line),
  }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = runMikoPull(realMikoPullDeps(process.cwd()))
