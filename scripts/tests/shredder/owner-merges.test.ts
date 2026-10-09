import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ownerMerges } from '../../shredder/authority.js'
import { readOwnerMergeKinds, readPlainPaths } from '../../shredder/reader.js'

const root = path.resolve(import.meta.dirname, '../../..')
const ownerMergesText = readFileSync(path.join(root, 'architecture/owner-merges.md'), 'utf8')
const kinds = readOwnerMergeKinds(ownerMergesText)

describe('architecture/owner-merges.md as the window reads it', () => {
  it.each([
    { files: ['AGENTS.md'], ownerMerged: true },
    { files: ['AGENTS.md', 'scripts/board/derive.ts'], ownerMerged: true },
    { files: ['templates/ai/shared/AGENTS.md.eta'], ownerMerged: false },
    { files: ['scripts/board/derive.ts', 'architecture/code-matrix.md'], ownerMerged: false },
    { files: ['.claude/agents/implementer.md'], ownerMerged: true },
    { files: ['.claude/rules/tests.md'], ownerMerged: true },
    { files: ['scripts/construct/implement.workflow'], ownerMerged: true },
    { files: ['templates/ai/claude/CLAUDE.md.eta'], ownerMerged: true },
    { files: ['templates/attach/AGENTS.md.eta'], ownerMerged: true },
    { files: ['contract/factory-permissions.json'], ownerMerged: true },
    { files: ['.github/workflows/release.yml'], ownerMerged: true },
    { files: ['architecture/security-invariants.md'], ownerMerged: true },
    { files: ['architecture/owner-merges.md'], ownerMerged: true },
    { files: ['scripts/ghosts/launch.ts'], ownerMerged: false },
    { files: ['scripts/ghosts/worktree-home.ts'], ownerMerged: false },
    { files: ['scripts/shift/header.md'], ownerMerged: false },
    { files: ['scripts/shift/merge.ts'], ownerMerged: false },
    { files: ['scripts/shredder/reader.ts'], ownerMerged: false },
    { files: ['scripts/shredder/authority.ts'], ownerMerged: false },
    { files: ['scripts/shredder/glob.ts'], ownerMerged: false },
  ])('$files → ownerMerged $ownerMerged', ({ files, ownerMerged }) => {
    expect(ownerMerges(files, kinds).ownerMerged).toBe(ownerMerged)
  })

  it('owner-merged kinds are release, release-workflow, security-invariants, agent-permissions, new-write-path and own-instructions', () => {
    expect(kinds.map(kind => kind.kind).sort()).toEqual(['agent-permissions', 'new-write-path', 'own-instructions', 'release', 'release-workflow', 'security-invariants'])
    expect(kinds.find(kind => kind.kind === 'release')?.title).toBe('chore: version packages')
    expect(kinds.find(kind => kind.kind === 'new-write-path')?.notChecked).toBe(true)
    expect(kinds.find(kind => kind.kind === 'own-instructions')?.globs).toEqual(['.claude/agents/**', '.claude/rules/**', 'AGENTS.md', 'scripts/construct/**', 'templates/ai/claude/**', 'templates/attach/**', 'architecture/owner-merges.md'])
    expect(kinds.find(kind => kind.kind === 'agent-permissions')?.globs).toEqual(['contract/factory-permissions.json'])
  })

  it('no kind names a path under scripts/shift or scripts/ghosts', () => {
    expect(kinds.flatMap(kind => kind.globs).filter(glob => /^scripts\/(?:shift|ghosts|shredder)\//.test(glob))).toEqual([])
    expect(readPlainPaths(ownerMergesText)).toEqual([])
  })
})
