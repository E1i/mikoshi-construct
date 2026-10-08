import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

export const SECURITY_INVARIANTS_FILE = 'architecture/security-invariants.md'
export const UNCHANGED = 'без изменений'
export const BLOCK_START = '<!-- release:security-invariants -->'
export const BLOCK_END = '<!-- /release:security-invariants -->'
const RELEASE_TAG_PATTERN = 'v*'

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

export function lastReleaseTag(cwd: string): string {
  return git(cwd, ['describe', '--tags', '--abbrev=0', `--match=${RELEASE_TAG_PATTERN}`, 'HEAD']).trim()
}

export function securityInvariantsDiff(cwd: string, tag: string): string {
  return git(cwd, ['diff', tag, 'HEAD', '--', SECURITY_INVARIANTS_FILE])
}

function longestBacktickRun(text: string): number {
  return Math.max(0, ...[...text.matchAll(/`+/g)].map(match => match[0].length))
}

export function securityInvariantsBlock(tag: string, diff: string): string {
  const heading = `### \`${SECURITY_INVARIANTS_FILE}\` since ${tag}`
  if (diff.trim() === '')
    return [BLOCK_START, heading, '', UNCHANGED, BLOCK_END].join('\n')
  const fence = '`'.repeat(Math.max(3, longestBacktickRun(diff) + 1))
  return [BLOCK_START, heading, '', `${fence}diff`, diff.trimEnd(), fence, BLOCK_END].join('\n')
}

export function withSecurityInvariantsBlock(body: string, block: string): string {
  const start = body.indexOf(BLOCK_START)
  const end = body.indexOf(BLOCK_END, start)
  const rest = start === -1 || end === -1 ? body : body.slice(0, start) + body.slice(end + BLOCK_END.length)
  return `${rest.trimEnd()}\n\n${block}\n`
}

function main(): void {
  const pr = process.argv[2]
  if (pr === undefined || pr === '') {
    console.log('no version pull request was created or updated; no security invariants block to write.')
    return
  }
  const cwd = process.cwd()
  const tag = lastReleaseTag(cwd)
  const block = securityInvariantsBlock(tag, securityInvariantsDiff(cwd, tag))
  const body = execFileSync('gh', ['pr', 'view', pr, '--json', 'body', '--jq', '.body'], { encoding: 'utf8' })
  execFileSync('gh', ['pr', 'edit', pr, '--body', withSecurityInvariantsBlock(body, block)], { stdio: 'inherit' })
  console.log(block)
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  main()
