import { execFileSync } from 'node:child_process'

export function pnpmVersion(): string {
  return execFileSync('pnpm', ['--version'], { encoding: 'utf8' }).trim()
}
