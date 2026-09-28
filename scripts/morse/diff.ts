import type { ChangedFile, FileStatus } from './rules.js'
import { execFileSync } from 'node:child_process'
import { MorseRefusal } from './rules.js'

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
}

export function resolveRevision(repo: string, revision: string): string {
  try {
    return git(repo, ['rev-parse', '--verify', `${revision}^{commit}`]).trim()
  }
  catch {
    throw new MorseRefusal(`unknown revision: ${revision}`)
  }
}

export function gitTopLevel(dir: string): string | null {
  try {
    return git(dir, ['rev-parse', '--show-toplevel']).trim()
  }
  catch {
    return null
  }
}

function splitRecords(output: string): string[] {
  const records = output.split('\0')
  if (records.length > 0 && records[records.length - 1] === '')
    records.pop()
  return records
}

const HANDLED_STATUSES: readonly string[] = ['A', 'M', 'D'] satisfies FileStatus[]

function parseNameStatus(output: string): Map<string, FileStatus> {
  const tokens = splitRecords(output)
  const statuses = new Map<string, FileStatus>()
  for (let i = 0; i < tokens.length; i += 2) {
    const status = tokens[i]
    const path = tokens[i + 1]
    if (!HANDLED_STATUSES.includes(status))
      throw new MorseRefusal(`unhandled git status ${status} for ${path}`)
    statuses.set(path, status as FileStatus)
  }
  return statuses
}

interface Counts {
  additions: number | null
  deletions: number | null
}

const LINE_COUNT = /^\d+$/

function countsOf(additionsRaw: string, deletionsRaw: string, path: string): Counts {
  if (additionsRaw === '-' && deletionsRaw === '-')
    return { additions: null, deletions: null }
  if (!LINE_COUNT.test(additionsRaw) || !LINE_COUNT.test(deletionsRaw))
    throw new MorseRefusal(`inconsistent diff: numstat reads ${additionsRaw}\t${deletionsRaw} for ${path}`)
  return { additions: Number(additionsRaw), deletions: Number(deletionsRaw) }
}

function parseNumstat(output: string): Map<string, Counts> {
  const tokens = splitRecords(output)
  const counts = new Map<string, Counts>()
  for (const token of tokens) {
    const firstTab = token.indexOf('\t')
    const secondTab = token.indexOf('\t', firstTab + 1)
    const additionsRaw = token.slice(0, firstTab)
    const deletionsRaw = token.slice(firstTab + 1, secondTab)
    const path = token.slice(secondTab + 1)
    counts.set(path, countsOf(additionsRaw, deletionsRaw, path))
  }
  return counts
}

export function changedFilesFrom(nameStatusOutput: string, numstatOutput: string): ChangedFile[] {
  const nameStatus = parseNameStatus(nameStatusOutput)
  const numstat = parseNumstat(numstatOutput)

  const files: ChangedFile[] = []
  for (const [path, status] of nameStatus) {
    const counts = numstat.get(path)
    if (counts === undefined)
      throw new MorseRefusal(`inconsistent diff: ${path} has a status and no numstat line`)
    files.push({ path, status, additions: counts.additions, deletions: counts.deletions })
  }
  return files
}

export function getChangedFiles(repo: string, base: string, head: string): ChangedFile[] {
  return changedFilesFrom(
    git(repo, ['diff', '--no-renames', '-z', '--name-status', base, head]),
    git(repo, ['diff', '--no-renames', '-z', '--numstat', base, head]),
  )
}
