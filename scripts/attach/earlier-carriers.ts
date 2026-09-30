import type { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { ATTACH_CARRIERS } from '../../src/presets/index.js'

export interface KnownCarrier {
  target: string
  sha256: string
  date: string
}

export interface Drift {
  missing: KnownCarrier[]
  extra: KnownCarrier[]
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const KNOWN_SET_FILE = path.join(REPO_ROOT, 'templates/attach/earlier-carriers.json')
const CLAUDE_SOURCE_ROOT = 'templates/ai/claude/'

function pairOf(entry: KnownCarrier): string {
  return `${entry.target}\u0000${entry.sha256}`
}

export function sourceOf(target: string): string {
  return `${CLAUDE_SOURCE_ROOT}${target.startsWith('.claude/') ? `_claude/${target.slice('.claude/'.length)}` : target}`
}

export function growKnownSet(existing: KnownCarrier[], found: KnownCarrier[]): KnownCarrier[] {
  const seen = new Set(existing.map(pairOf))
  const added: KnownCarrier[] = []
  for (const entry of found) {
    if (seen.has(pairOf(entry)))
      continue
    seen.add(pairOf(entry))
    added.push(entry)
  }
  return [...existing, ...added]
}

export function driftOf(file: KnownCarrier[], found: KnownCarrier[]): Drift {
  const inFile = new Set(file.map(pairOf))
  const inSources = new Set(found.map(pairOf))
  return {
    missing: found.filter(entry => !inFile.has(pairOf(entry))),
    extra: file.filter(entry => !inSources.has(pairOf(entry))),
  }
}

export function renderKnownSet(entries: KnownCarrier[]): string {
  return `${JSON.stringify(entries, null, 2)}\n`
}

function git(args: string[], input?: string): Buffer {
  return execFileSync('git', args, { cwd: REPO_ROOT, input, maxBuffer: 1 << 28 })
}

function sha256Of(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function historyOf(target: string): KnownCarrier[] {
  const source = sourceOf(target)
  const commits = git(['log', '--full-history', '--format=%H %cs', '--', source]).toString('utf8').split('\n').filter(line => line !== '').map((line) => {
    const [commit = '', date = ''] = line.split(' ')
    return { commit, date }
  }).reverse()
  const specs = commits.map(({ commit }) => `${commit}:${source}\n`).join('')
  const checked = git(['cat-file', '--batch-check'], specs).toString('utf8').split('\n')
  const dateByBlob = new Map<string, string>()
  commits.forEach(({ date }, index) => {
    const [blob, type] = (checked[index] ?? '').split(' ')
    if (type !== 'blob' || blob == null)
      return
    const known = dateByBlob.get(blob)
    if (known == null || date < known)
      dateByBlob.set(blob, date)
  })
  return [...dateByBlob.entries()]
    .sort((a, b) => a[1].localeCompare(b[1]))
    .map(([blob, date]) => ({ target, sha256: sha256Of(git(['cat-file', 'blob', blob])), date }))
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

export function sourcesHave(): KnownCarrier[] {
  return ATTACH_CARRIERS.targets.flatMap((target) => {
    const history = historyOf(target)
    const current = sha256Of(readFileSync(path.join(REPO_ROOT, sourceOf(target))))
    return history.some(entry => entry.sha256 === current)
      ? history
      : [...history, { target, sha256: current, date: today() }]
  })
}

function readKnownSet(): KnownCarrier[] {
  return JSON.parse(readFileSync(KNOWN_SET_FILE, 'utf8')) as KnownCarrier[]
}

function readKnownSetOrEmpty(): KnownCarrier[] {
  try {
    return readKnownSet()
  }
  catch {
    return []
  }
}

function describe(entry: KnownCarrier): string {
  return `${entry.target} ${entry.sha256}`
}

function main(): void {
  const { values } = parseArgs({ options: { check: { type: 'boolean', default: false } } })
  const found = sourcesHave()
  if (values.check) {
    const { missing, extra } = driftOf(readKnownSet(), found)
    if (missing.length === 0 && extra.length === 0)
      return
    const lines = [
      ...missing.map(entry => `missing from the file: ${describe(entry)}`),
      ...extra.map(entry => `in the file, in neither history nor the working tree: ${describe(entry)}`),
    ]
    console.error(lines.join('\n'))
    process.exitCode = 1
    return
  }
  writeFileSync(KNOWN_SET_FILE, renderKnownSet(growKnownSet(readKnownSetOrEmpty(), found)))
}

if (realpathSync(process.argv[1] ?? '') === fileURLToPath(import.meta.url))
  main()
