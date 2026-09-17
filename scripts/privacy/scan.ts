import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ALLOWED_DOMAINS } from './allowlist.js'

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
export const SCANNED_PATHS = ['templates', 'docs', 'README.md']

const MENTIONED_TLDS = ['com', 'org', 'net', 'io', 'dev', 'co', 'ai', 'sh', 'app', 'me', 'gg', 'cloud', 'tech', 'xyz', 'info', 'run']
const HOST = String.raw`[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}`
const URL_HOST_PATTERN = new RegExp(String.raw`[a-z][a-z0-9+.-]*://(${HOST})`, 'gi')
const EMAIL_HOST_PATTERN = new RegExp(String.raw`[a-z0-9][\w.%+-]*@(${HOST})`, 'gi')
const MENTIONED_HOST_PATTERN = new RegExp(String.raw`\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+(?:${MENTIONED_TLDS.join('|')})\b`, 'gi')
const IP_PATTERN = /\b\d{1,3}(?:\.\d{1,3}){3}\b/g
const HOME_PATH_PATTERN = /(?:\/Users\/|\/home\/|~\/)[a-z0-9][\w.-]*/gi

export interface Violation {
  file: string
  line: number
  kind: 'domain' | 'home-path'
  value: string
}

function registrable(host: string): string {
  const lower = host.toLowerCase()
  return lower.startsWith('www.') ? lower.slice(4) : lower
}

function hostsIn(line: string): string[] {
  return [
    ...[...line.matchAll(URL_HOST_PATTERN)].map(match => match[1]),
    ...[...line.matchAll(EMAIL_HOST_PATTERN)].map(match => match[1]),
    ...[...line.matchAll(MENTIONED_HOST_PATTERN)].map(match => match[0]),
    ...[...line.matchAll(IP_PATTERN)].map(match => match[0]),
  ]
}

export function scanText(text: string, file: string, allowed: string[] = ALLOWED_DOMAINS): Violation[] {
  const permitted = new Set(allowed.map(registrable))
  const violations: Violation[] = []
  text.split('\n').forEach((line, index) => {
    const reported = new Set<string>()
    for (const host of hostsIn(line)) {
      const name = registrable(host)
      if (permitted.has(name) || reported.has(name))
        continue
      reported.add(name)
      violations.push({ file, line: index + 1, kind: 'domain', value: host })
    }
    for (const match of line.matchAll(HOME_PATH_PATTERN))
      violations.push({ file, line: index + 1, kind: 'home-path', value: match[0] })
  })
  return violations
}

export function scannedFiles(root = REPO_ROOT, targets = SCANNED_PATHS): string[] {
  const files: string[] = []
  const walk = (relative: string): void => {
    const absolute = path.join(root, relative)
    if (statSync(absolute).isDirectory()) {
      for (const entry of readdirSync(absolute).sort())
        walk(path.join(relative, entry))
      return
    }
    files.push(relative)
  }
  for (const target of targets)
    walk(target)
  return files
}

export function scanRepository(root = REPO_ROOT, targets = SCANNED_PATHS): Violation[] {
  return scannedFiles(root, targets)
    .flatMap(file => scanText(readFileSync(path.join(root, file), 'utf8'), file))
}

export function formatViolation(violation: Violation): string {
  const reason = violation.kind === 'domain'
    ? `domain "${violation.value}" is not in scripts/privacy/allowlist.ts`
    : `home directory path "${violation.value}" is not allowed`
  return `${violation.file}:${violation.line}: ${reason}`
}
