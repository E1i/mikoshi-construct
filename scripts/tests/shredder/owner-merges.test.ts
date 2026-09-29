import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ownerMerges } from '../../shredder/authority.js'
import { readOwnerMergeKinds } from '../../shredder/reader.js'

const kinds = readOwnerMergeKinds(readFileSync(path.resolve(import.meta.dirname, '../../../architecture/owner-merges.md'), 'utf8'))

describe('architecture/owner-merges.md as the window reads it', () => {
  it.each([
    { files: ['AGENTS.md'], ownerMerged: true },
    { files: ['AGENTS.md', 'scripts/board/derive.ts'], ownerMerged: true },
    { files: ['templates/ai/shared/AGENTS.md.eta'], ownerMerged: false },
    { files: ['scripts/board/derive.ts', 'architecture/code-matrix.md'], ownerMerged: false },
  ])('$files → ownerMerged $ownerMerged', ({ files, ownerMerged }) => {
    expect(ownerMerges(files, kinds).ownerMerged).toBe(ownerMerged)
  })
})
