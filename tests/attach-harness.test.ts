import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'vitest'
import { fileEditingMarks, throughPackageRunners, unresolvedCommandWord } from '../src/commands/attach/harness.js'

function executable(directory: string, name: string): void {
  mkdirSync(directory, { recursive: true })
  const file = path.join(directory, name)
  writeFileSync(file, '#!/bin/sh\nexit 0\n')
  chmodSync(file, 0o755)
}

const root = mkdtempSync(path.join(tmpdir(), 'construct-attach-harness-'))
const bin = path.join(root, 'bin')
const cwdLike = path.join(root, 'repo')
executable(bin, 'pnpm')
executable(cwdLike, 'quality')
const SEARCH_PATH = [bin, '', '.', path.relative(process.cwd(), cwdLike)].join(path.delimiter)

const COMMANDS: Record<string, string | null> = {
  'pnpm quality': null,
  './run.sh': null,
  'CI=1 vitest run': 'vitest',
  'quality': 'quality',
  'cd app && pnpm test': null,
  '  pnpm run quality  ': null,
}

describe('attach names the first word of a harness command that PATH does not resolve', () => {
  for (const [command, word] of Object.entries(COMMANDS)) {
    it(`${JSON.stringify(command)} → ${word ?? 'resolves'}`, () => {
      expect(unresolvedCommandWord(command, SEARCH_PATH)).toBe(word)
    })
  }

  it('does not count an executable reached only through a relative PATH entry', () => {
    expect(unresolvedCommandWord('quality', [cwdLike, bin].join(path.delimiter))).toBeNull()
    expect(unresolvedCommandWord('quality', SEARCH_PATH)).toBe('quality')
  })
})

describe('the next step keeps the rest of the command and puts a package runner before the word', () => {
  it('a bare script name', () => {
    expect(throughPackageRunners('quality', 'quality')).toEqual(['npm run quality', 'npx quality'])
  })

  it('an environment assignment and arguments stay where they were', () => {
    expect(throughPackageRunners('CI=1 vitest run', 'vitest')).toEqual(['CI=1 npm run vitest run', 'CI=1 npx vitest run'])
  })
})

const EDITS: Record<string, string[]> = {
  'pnpm run quality': [],
  'pnpm lint:fix': ['lint:fix'],
  'npx eslint . --fix': ['--fix'],
  'prettier --write . && pnpm test': ['--write'],
  'pnpm lint:fix && eslint . --fix': ['lint:fix', '--fix'],
  'eslint --fix-dry-run .': [],
}

describe('attach names what makes a harness command edit files', () => {
  for (const [command, marks] of Object.entries(EDITS)) {
    it(`${JSON.stringify(command)} → ${marks.length === 0 ? 'nothing' : marks.join(', ')}`, () => {
      expect(fileEditingMarks(command)).toEqual(marks)
    })
  }
})
