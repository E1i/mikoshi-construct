import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseChangeset } from '../scripts/release-notes/pending.js'
import { pendingChangesets } from '../scripts/release/changesets.js'

const CHANGESET_DIR = path.resolve(import.meta.dirname, '../.changeset')

function summariesPastOneLine(dir: string): string[] {
  return pendingChangesets(readdirSync(dir))
    .filter(file => parseChangeset(readFileSync(path.join(dir, file), 'utf8'))?.summary.includes('\n') === true)
}

describe('a pending changeset is one line, and the details live in its pull request', () => {
  it('finds no pending changeset whose summary runs past one line', () => {
    expect(summariesPastOneLine(CHANGESET_DIR)).toEqual([])
  })
})
