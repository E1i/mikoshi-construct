import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ownerMerges } from '../../shredder/authority.js'
import { matchGlob } from '../../shredder/glob.js'
import { readOwnerMergeKinds, readPlainPaths } from '../../shredder/reader.js'

const root = path.resolve(import.meta.dirname, '../../..')
const ownerMergesText = readFileSync(path.join(root, 'architecture/owner-merges.md'), 'utf8')
const kinds = readOwnerMergeKinds(ownerMergesText)
const plainPaths = readPlainPaths(ownerMergesText)
const ghostFiles = readdirSync(path.join(root, 'scripts/ghosts'), { recursive: true, withFileTypes: true })
  .filter(entry => entry.isFile())
  .map(entry => path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
  .sort()

function classificationErrors(files: string[]): string[] {
  const ownerGlobs = kinds.find(kind => kind.kind === 'ghosts')?.globs ?? []
  return files.flatMap((file) => {
    const owner = ownerGlobs.some(glob => matchGlob(glob, file))
    const plain = plainPaths.includes(file)
    if (owner && plain)
      return [`classify ${file} in owner-merges.md: it is both owner and plain`]
    if (!owner && !plain)
      return [`classify ${file} in owner-merges.md`]
    return []
  })
}

describe('architecture/owner-merges.md as the window reads it', () => {
  it.each([
    { files: ['AGENTS.md'], ownerMerged: true },
    { files: ['AGENTS.md', 'scripts/board/derive.ts'], ownerMerged: true },
    { files: ['templates/ai/shared/AGENTS.md.eta'], ownerMerged: false },
    { files: ['scripts/board/derive.ts', 'architecture/code-matrix.md'], ownerMerged: false },
    { files: ['scripts/ghosts/expect-sample.ts'], ownerMerged: false },
    { files: ['scripts/ghosts/launch.ts'], ownerMerged: true },
    { files: ['scripts/ghosts/journal.ts'], ownerMerged: true },
    { files: ['architecture/owner-merges.md'], ownerMerged: true },
  ])('$files → ownerMerged $ownerMerged', ({ files, ownerMerged }) => {
    expect(ownerMerges(files, kinds).ownerMerged).toBe(ownerMerged)
  })

  it('classifies every file under scripts/ghosts/** in exactly one list', () => {
    expect(ghostFiles.length).toBeGreaterThan(0)
    expect(classificationErrors(ghostFiles)).toEqual([])
  })

  it('names a new file under scripts/ghosts/** that no list classifies', () => {
    expect(classificationErrors([...ghostFiles, 'scripts/ghosts/x.ts'])).toEqual(['classify scripts/ghosts/x.ts in owner-merges.md'])
  })

  it('lists only plain paths that exist', () => {
    expect(plainPaths.filter(file => !ghostFiles.includes(file))).toEqual([])
  })
})
