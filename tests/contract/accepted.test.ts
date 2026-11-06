import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { mergePolicy } from '../../scripts/policy/policy.js'
import { cardBody } from '../../scripts/tests/bus/github-fake.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '../..')
const ACCEPTED = 'contract/accepted.json'
const MODULE_ROOTS = ['src', 'scripts']
const NOT_MODULES = /^scripts\/tests\//
const SOURCE_FILE = /\.(?:ts|mts|mjs|js)$/
const NAMES_THE_ACCEPTED_MODEL = /accepted\.json/
const ANY_WRITE_CALL = /\b(?:writeFile|appendFile|rename|copyFile|cp|createWriteStream|writeJson|writeAtomic)\w*\(/

function writesTheAcceptedModel(source: string): boolean {
  return NAMES_THE_ACCEPTED_MODEL.test(source) && ANY_WRITE_CALL.test(source)
}

function modulesUnder(root: string): string[] {
  return readdirSync(path.join(REPO_ROOT, root), { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && SOURCE_FILE.test(entry.name))
    .map(entry => path.relative(REPO_ROOT, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
    .filter(file => !NOT_MODULES.test(file))
}

describe('the accepted model', () => {
  const ownerMergesText = readFileSync(path.join(REPO_ROOT, 'architecture/owner-merges.md'), 'utf8')

  it('the record holds its version and the concepts the owner ratified', () => {
    expect(JSON.parse(readFileSync(path.join(REPO_ROOT, ACCEPTED), 'utf8'))).toEqual({
      acceptedVersion: 1,
      concepts: { 'generated-files': { owner: 'scripts/core/generated-files.ts', decision: 'D-335' } },
    })
  })

  it('the accepted model is an owner-merged path', () => {
    for (const lifted of [{}, { shardActive: true }, { windowShard: 'shard-1' }]) {
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

  it('a module that names the accepted model and writes anything is a writer, whatever the variable and however the call is split', () => {
    expect(writesTheAcceptedModel(`writeFileSync('${ACCEPTED}', text)`)).toBe(true)
    expect(writesTheAcceptedModel(`const target = '${ACCEPTED}'\nwriteFileSync(target, text)`)).toBe(true)
    expect(writesTheAcceptedModel(`renameSync(\n  temporary,\n  '${ACCEPTED}',\n)`)).toBe(true)
  })

  it('a module that only reads the accepted model, and a writer that never names it, are not writers', () => {
    expect(writesTheAcceptedModel(`readFileSync('${ACCEPTED}', 'utf8')`)).toBe(false)
    expect(writesTheAcceptedModel(`writeFileSync('contract/factory.json', text)`)).toBe(false)
  })
})
