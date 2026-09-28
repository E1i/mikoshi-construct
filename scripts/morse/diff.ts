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

function splitRecords(output: string): string[] {
  const records = output.split('\0')
  if (records.length > 0 && records[records.length - 1] === '')
    records.pop()
  return records
}

function parseNameStatus(output: string): Map<string, FileStatus> {
  const tokens = splitRecords(output)
  const statuses = new Map<string, FileStatus>()
  for (let i = 0; i < tokens.length; i += 2) {
    const status = tokens[i] as FileStatus
    const path = tokens[i + 1]
    statuses.set(path, status)
  }
  return statuses
}

interface Counts {
  additions: number | null
  deletions: number | null
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
    counts.set(path, {
      additions: additionsRaw === '-' ? null : Number(additionsRaw),
      deletions: deletionsRaw === '-' ? null : Number(deletionsRaw),
    })
  }
  return counts
}

export function getChangedFiles(repo: string, base: string, head: string): ChangedFile[] {
  const nameStatus = parseNameStatus(git(repo, ['diff', '--no-renames', '-z', '--name-status', base, head]))
  const numstat = parseNumstat(git(repo, ['diff', '--no-renames', '-z', '--numstat', base, head]))

  const files: ChangedFile[] = []
  for (const [path, status] of nameStatus) {
    const counts = numstat.get(path) ?? { additions: null, deletions: null }
    files.push({ path, status, additions: counts.additions, deletions: counts.deletions })
  }
  return files
}
