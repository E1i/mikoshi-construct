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

function sourceOf(file: string): string {
  return readFileSync(path.join(REPO_ROOT, file), 'utf8')
}

function declares(source: string, symbol: string): boolean {
  return new RegExp(`^(?:export )?(?:async )?(?:function|interface|const|let|class|type) ${symbol}\\b`, 'm').test(source)
}

describe('the decision and rule symbols stand with their owners', () => {
  it('decisions/read.ts declares the round limit decision symbols, CleanUpdate and OWNER_EVEN_UNDER_THE_DECISION, and cleanUpdatesOf lives in round-limit-decision.ts', () => {
    const read = sourceOf(DECISIONS_READ)
    const rules = sourceOf(ROUND_LIMIT_DECISION)
    const updateDone = sourceOf(UPDATE_DONE)
    expect([...ROUND_LIMIT_SYMBOLS, CLEAN_UPDATE, OWNER_EVEN_UNDER_THE_DECISION].filter(symbol => !declares(read, symbol))).toEqual([])
    expect(declares(rules, CLEAN_UPDATES_OF)).toBe(true)
    expect(ROUND_LIMIT_SYMBOLS.filter(symbol => declares(rules, symbol))).toEqual([])
    expect([CLEAN_UPDATE, CLEAN_UPDATES_OF].filter(symbol => declares(updateDone, symbol))).toEqual([])
    expect(declares(sourceOf(POLICY), OWNER_EVEN_UNDER_THE_DECISION)).toBe(false)
  })
})
