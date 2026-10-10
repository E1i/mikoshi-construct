import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PREFIX, runTreePr } from '../../shift/tree-pr-cli.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

function untouchable(): never {
  throw new Error('no git or gh call is expected')
}

describe('tree-pr for a finished card session', () => {
  it('a card file that moved while the session ran is a problem line, not a stack trace', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'tree-pr-cli-'))
    roots.push(root)
    const cardFile = path.join(root, 'lane-q', '951.md')
    const lines: string[] = []

    const code = runTreePr([cardFile, root], { git: untouchable, gh: untouchable }, line => lines.push(line))

    expect({ code, lines }).toEqual({ code: 1, lines: [`${PREFIX}951.md: the card file ${cardFile} is gone (moved to another lane or archived while the session ran); the tree is left uncommitted`] })
  })
})
