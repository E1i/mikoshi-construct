import { spawnSync } from 'node:child_process'

export function bashSyntaxProblem(command: string): string | null {
  const result = spawnSync('bash', ['-n', '-c', command], { encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'], shell: false })
  if (result.status === 0)
    return null
  const message = result.error?.message ?? result.stderr ?? ''
  return message.split('\n').map(line => line.trim()).filter(line => line !== '').join('; ')
}
