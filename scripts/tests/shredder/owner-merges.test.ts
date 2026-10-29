import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { FACTORY_FORMER_FOLDERS, FACTORY_ROOT, inScopes } from '../../core/factory-paths.js'
import { ownerMerges } from '../../policy/shredder/authority.js'
import { GHOSTS_FILES, readGhostsFiles, readOwnerMergeKinds } from '../../policy/shredder/reader.js'

const root = path.resolve(import.meta.dirname, '../../..')
const ownerMergesText = readFileSync(path.join(root, 'architecture/owner-merges.md'), 'utf8')
const kinds = readOwnerMergeKinds(ownerMergesText)
const ghostsFilesRows = readGhostsFiles(readFileSync(path.join(root, GHOSTS_FILES), 'utf8'))
const plainPaths = ghostsFilesRows.filter(row => row.kind === 'plain').map(row => row.file)
const ghostFiles = readdirSync(path.join(root, FACTORY_ROOT), { recursive: true, withFileTypes: true })
  .filter(entry => entry.isFile())
  .map(entry => path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
  .filter(file => inScopes(file, FACTORY_FORMER_FOLDERS.ghosts))
  .sort()

function classificationErrors(files: string[]): string[] {
  return files.flatMap((file) => {
    const owner = ghostsFilesRows.some(row => row.file === file && row.kind === 'ghosts')
    const plain = plainPaths.includes(file)
    if (owner && plain)
      return [`classify ${file} in ${GHOSTS_FILES}: it is both ghosts and plain`]
    if (!owner && !plain)
      return [`classify ${file} in ${GHOSTS_FILES}`]
    return []
  })
}

describe('architecture/owner-merges.md as the window reads it', () => {
  it.each([
    { files: ['AGENTS.md'], ownerMerged: false },
    { files: ['AGENTS.md', 'scripts/board/derive.ts'], ownerMerged: false },
    { files: ['templates/ai/shared/AGENTS.md.eta'], ownerMerged: false },
    { files: ['scripts/board/derive.ts', 'architecture/code-matrix.md'], ownerMerged: false },
    { files: ['.claude/agents/implementer.md'], ownerMerged: true },
    { files: ['.claude/rules/tests.md'], ownerMerged: true },
    { files: ['.claude/settings.json'], ownerMerged: true },
    { files: ['.claude/settings.local.json'], ownerMerged: true },
    { files: ['.claude/skills/implement/SKILL.md'], ownerMerged: true },
    { files: ['.claude/commands/plan.md'], ownerMerged: true },
    { files: ['.claude/hooks/x.mjs'], ownerMerged: true },
    { files: ['.claude/eddies.json'], ownerMerged: true },
    { files: ['.claude/statusline.sh'], ownerMerged: true },
    { files: ['architecture/ghosts-files.md'], ownerMerged: false },
    { files: ['scripts/construct/implement.workflow'], ownerMerged: false },
    { files: ['templates/ai/claude/CLAUDE.md.eta'], ownerMerged: false },
    { files: ['templates/attach/AGENTS.md.eta'], ownerMerged: false },
    { files: ['contract/factory-permissions.json'], ownerMerged: true },
    { files: ['.github/workflows/release.yml'], ownerMerged: true },
    { files: ['.github/workflows/ci.yml'], ownerMerged: true },
    { files: ['architecture/security-invariants.md'], ownerMerged: true },
    { files: ['architecture/owner-merges.md'], ownerMerged: false },
    { files: ['scripts/ladder/launch.ts'], ownerMerged: false },
    { files: ['scripts/ladder/isolation.ts'], ownerMerged: false },
    { files: ['scripts/nodes/launch/header.md'], ownerMerged: false },
    { files: ['scripts/window/handoff-write.ts'], ownerMerged: false },
    { files: ['scripts/policy/shredder/reader.ts'], ownerMerged: false },
    { files: ['scripts/policy/shredder/authority.ts'], ownerMerged: false },
    { files: ['scripts/policy/shredder/glob.ts'], ownerMerged: false },
  ])('$files → ownerMerged $ownerMerged', ({ files, ownerMerged }) => {
    expect(ownerMerges(files, kinds).ownerMerged).toBe(ownerMerged)
  })

  it('owner-merged kinds are release, release-workflow, workflows, security-invariants, agent-permissions, new-write-path and own-instructions', () => {
    expect(kinds.map(kind => kind.kind).sort()).toEqual(['agent-permissions', 'new-write-path', 'own-instructions', 'release', 'release-workflow', 'security-invariants', 'workflows'])
    expect(kinds.find(kind => kind.kind === 'workflows')?.globs).toEqual(['.github/workflows/**'])
    expect(kinds.find(kind => kind.kind === 'release')?.title).toBe('chore: version packages')
    expect(kinds.find(kind => kind.kind === 'new-write-path')?.notChecked).toBe(true)
    expect(kinds.find(kind => kind.kind === 'own-instructions')?.globs).toEqual(['.claude/**'])
    expect(kinds.find(kind => kind.kind === 'agent-permissions')?.globs).toEqual(['contract/factory-permissions.json'])
  })

  it('no kind names a path of the former scripts/shift or scripts/ghosts, or under scripts/policy/shredder', () => {
    expect(kinds.flatMap(kind => kind.globs).filter(glob => inScopes(glob, [...FACTORY_FORMER_FOLDERS.ghosts, ...FACTORY_FORMER_FOLDERS.shift, 'scripts/policy/shredder']))).toEqual([])
    expect(readGhostsFiles(ownerMergesText)).toEqual([])
  })
})

describe('architecture/ghosts-files.md as the shift and the preflight read it', () => {
  it('classifies every file of the former scripts/ghosts in exactly one kind', () => {
    expect(ghostFiles.length).toBeGreaterThan(0)
    expect(classificationErrors(ghostFiles)).toEqual([])
  })

  it('names a new file under scripts/ladder/** that no row classifies', () => {
    expect(classificationErrors([...ghostFiles, 'scripts/ladder/x.ts'])).toEqual([`classify scripts/ladder/x.ts in ${GHOSTS_FILES}`])
  })

  it('lists only plain paths that exist', () => {
    expect(plainPaths.filter(file => !ghostFiles.includes(file))).toEqual([])
  })

  it('lists only ghosts paths that exist', () => {
    expect(ghostsFilesRows.filter(row => row.kind === 'ghosts' && !ghostFiles.includes(row.file))).toEqual([])
  })
})
