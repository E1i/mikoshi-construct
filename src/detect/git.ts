import { spawnSync } from 'node:child_process'

export interface CommandReading {
  command: string
  exit: number | null
  effects: string[]
  stdout: string
}

const READ_ONLY_GIT = ['-c', 'core.fsmonitor=false', '--no-optional-locks']

function runGit(root: string, args: string[]): CommandReading {
  const result = spawnSync('git', [...READ_ONLY_GIT, ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], shell: false })
  return {
    command: ['git', ...args].join(' '),
    exit: typeof result.status === 'number' ? result.status : null,
    effects: [],
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
  }
}

export function readHead(root: string): CommandReading {
  return runGit(root, ['rev-parse', 'HEAD'])
}

export function readTrackedFiles(root: string): CommandReading {
  return runGit(root, ['ls-files', '-z'])
}
