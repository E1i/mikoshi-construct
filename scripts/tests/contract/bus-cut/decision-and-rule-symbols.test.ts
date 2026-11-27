import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = path.resolve(import.meta.dirname, '../../../..')
const DECISIONS_READ = 'scripts/policy/decisions/read.ts'
const ROUND_LIMIT_DECISION = 'scripts/policy/round-limit-decision.ts'
const UPDATE_DONE = 'scripts/nodes/update/update-done.ts'
const POLICY = 'scripts/policy/policy.ts'
const ROUND_LIMIT_SYMBOLS = ['continueFixesDecisionOf', 'namesPrAtHead', 'observedHeadsOf', 'namesPrAtHeadUnder', 'ALLOW_MERGE', 'decisionUnder', 'headsWithTheSameDiff', 'headsOf'] as const
const CLEAN_UPDATE = 'CleanUpdate'
const CLEAN_UPDATES_OF = 'cleanUpdatesOf'
const OWNER_EVEN_UNDER_THE_DECISION = 'OWNER_EVEN_UNDER_THE_DECISION'
const FACTORY_READERS = ['scripts/contract/factory/modules.js', 'contract/ratchet.js']

function sourceOf(file: string): string {
  return readFileSync(path.join(REPO_ROOT, file), 'utf8')
}

function declares(source: string, symbol: string): boolean {
  return new RegExp(`^(?:export )?(?:async )?(?:function|interface|const|let|class|type) ${symbol}\\b`, 'm').test(source)
}

describe('the round limit decision symbols, CleanUpdate and OWNER_EVEN_UNDER_THE_DECISION live in decisions/read.ts', () => {
  it('decisions/read.ts declares the eight round limit symbols, CleanUpdate and OWNER_EVEN_UNDER_THE_DECISION', () => {
    const read = sourceOf(DECISIONS_READ)
    expect([...ROUND_LIMIT_SYMBOLS, CLEAN_UPDATE, OWNER_EVEN_UNDER_THE_DECISION].filter(symbol => !declares(read, symbol))).toEqual([])
  })

  it('round-limit-decision.ts declares cleanUpdatesOf and none of the eight moved symbols', () => {
    const rules = sourceOf(ROUND_LIMIT_DECISION)
    expect(declares(rules, CLEAN_UPDATES_OF)).toBe(true)
    expect(ROUND_LIMIT_SYMBOLS.filter(symbol => declares(rules, symbol))).toEqual([])
  })

  it('update-done.ts declares neither CleanUpdate nor cleanUpdatesOf, and policy.ts does not declare OWNER_EVEN_UNDER_THE_DECISION', () => {
    const updateDone = sourceOf(UPDATE_DONE)
    expect([CLEAN_UPDATE, CLEAN_UPDATES_OF].filter(symbol => declares(updateDone, symbol))).toEqual([])
    expect(declares(sourceOf(POLICY), OWNER_EVEN_UNDER_THE_DECISION)).toBe(false)
  })

  it('this test reads sources as text and imports no factory reader', () => {
    const own = sourceOf(path.relative(REPO_ROOT, import.meta.filename))
    expect(FACTORY_READERS.filter(reader => own.includes(`from '${reader}`) || own.includes(`/${reader}'`))).toEqual([])
  })
})
