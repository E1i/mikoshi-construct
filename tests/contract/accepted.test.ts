import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { mergePolicy } from '../../scripts/policy/policy.js'
import { ownerMerges } from '../../scripts/policy/shredder/authority.js'
import { readOwnerMergeKinds } from '../../scripts/policy/shredder/reader.js'
import { cardBody } from '../../scripts/tests/bus/github-fake.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')
const ACCEPTED = 'contract/accepted.json'
const MODULE_ROOTS = ['src', 'scripts']
const NOT_MODULES = /^scripts\/tests\//
const SOURCE_FILE = /\.(?:ts|mts|mjs|js)$/
const WRITE_OF_THE_ACCEPTED_MODEL = /(?:writeFile|appendFile|rename|copyFile|cp|createWriteStream|writeJson|writeAtomic)\w*\([^)\n]*accepted/i

function writesTheAcceptedModel(source: string): boolean {
  return WRITE_OF_THE_ACCEPTED_MODEL.test(source)
}

function modulesUnder(root: string): string[] {
  return readdirSync(path.join(REPO_ROOT, root), { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && SOURCE_FILE.test(entry.name))
    .map(entry => path.relative(REPO_ROOT, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
    .filter(file => !NOT_MODULES.test(file))
}

describe('the accepted model', () => {
  const ownerMergesText = readFileSync(path.join(REPO_ROOT, 'architecture/owner-merges.md'), 'utf8')

  it('the record holds its version and an empty map of concepts: this carrier ratifies nothing', () => {
    expect(JSON.parse(readFileSync(path.join(REPO_ROOT, ACCEPTED), 'utf8'))).toEqual({ acceptedVersion: 1, concepts: {} })
  })

  it('the accepted model is an owner-merged path', () => {
    expect(ownerMerges([ACCEPTED], readOwnerMergeKinds(ownerMergesText)).ownerMerged).toBe(true)
    for (const lifted of [{ shardActive: true }, { windowShard: 'shard-1' }]) {
      const verdict = mergePolicy({
        cardId: 1042,
        description: cardBody(942),
        headRef: 'feat/card-1042',
        title: 'feat: card #1042',
        files: [ACCEPTED],
        patched: [],
        ownerMergesText,
        shardActive: false,
        shardUnder: null,
        windowShard: null,
        decisions: [],
        ...lifted,
      })
      expect(verdict).toMatchObject({ kind: 'denied', rule: 'no_shard_merge' })
    }
  })

  it('no module writes the accepted model', () => {
    const writers = MODULE_ROOTS.flatMap(modulesUnder)
      .filter(file => writesTheAcceptedModel(readFileSync(path.join(REPO_ROOT, file), 'utf8')))
    expect(writers).toEqual([])
  })

  it('the write detector sees a write and lets a read through', () => {
    expect(writesTheAcceptedModel(`writeFileSync('${ACCEPTED}', text)`)).toBe(true)
    expect(writesTheAcceptedModel('renameSync(temporary, acceptedPath)')).toBe(true)
    expect(writesTheAcceptedModel(`readFileSync('${ACCEPTED}', 'utf8')`)).toBe(false)
  })
})
