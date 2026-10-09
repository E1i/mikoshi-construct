import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const SCANNED_ROOTS = ['architecture', '.claude', 'scripts/shift']
const READER_SOURCE = 'scripts/decisions/'
const RAW_FILE = 'owner-decisions.md'
const READER = 'pnpm decisions'

function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files', '--', ...SCANNED_ROOTS], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(file => file !== '' && !file.startsWith(READER_SOURCE))
}

function rawReads(text: string): number[] {
  return text.split('\n').flatMap((line, index) => line.includes(RAW_FILE) && !line.includes(READER) ? [index + 1] : [])
}

describe('owner decisions are read through pnpm decisions', () => {
  it('no tracked text under architecture/, .claude/ or scripts/shift/ names the raw file without the reader', () => {
    const offenders = trackedFiles().flatMap(file =>
      rawReads(readFileSync(path.join(REPO_ROOT, file), 'utf8')).map(line => `${file}:${line}`),
    )
    expect(offenders).toEqual([])
  })

  it('a line naming the raw file alone is a raw read', () => {
    expect(rawReads(`they live in ~/.construct/${RAW_FILE}`)).toEqual([1])
  })

  it('a line naming the raw file as the reader\'s argument is not', () => {
    expect(rawReads(`read them with \`${READER}\` (~/.construct/${RAW_FILE} by default)`)).toEqual([])
  })
})
