import type { Prediction, RuleId } from '../../morse/rules.js'
import { describe, expect, it } from 'vitest'
import { classify, classifyTouches, RULES } from '../../morse/rules.js'

const PLAN_TOUCHES = {
  1038: ['scripts/morse/backtest.ts', 'scripts/morse/cli.ts', 'scripts/tests/morse/cli.test.ts', 'scripts/shift/answer-record.ts', 'scripts/tests/shift/answer-record.test.ts', 'package.json', 'tests/harness-membership.test.ts', 'CONTRIBUTING.md', 'scripts/ci/test-weights.json'],
  1039: ['scripts/bench/**', 'scripts/tests/bench/**', 'package.json', 'tests/harness-membership.test.ts', 'CONTRIBUTING.md', 'scripts/ci/test-weights.json'],
  1041: ['scripts/board/**', 'scripts/tests/board/**', 'package.json', 'tests/harness-membership.test.ts', 'CONTRIBUTING.md', 'scripts/ci/test-weights.json'],
}

describe('morse rule ids', () => {
  it('a rule id outside RULES does not compile', () => {
    // @ts-expect-error a rule id is one of the ids RULES lists
    const typo: RuleId = 'docs_only'
    // @ts-expect-error a prediction names a rule RULES lists
    const prediction: Prediction = { verdict: 'cheap', rule: 'docs_only', why: [] }
    expect(RULES.map(rule => rule.id)).not.toContain(typo)
    expect(prediction.rule).toBe(typo)
  })
})

describe('morse doubt fires only on a named ground', () => {
  it('touches of #1038, #1039 and #1041 classify cheap', () => {
    for (const touches of Object.values(PLAN_TOUCHES))
      expect(classifyTouches(touches, false)).toEqual({ verdict: 'cheap', rule: 'no-ground', why: [...touches].sort() })
  })

  it('a touch that reads R1 classifies not cheap', () => {
    const prediction = classifyTouches(['scripts/ghosts/hash.ts', 'scripts/tests/ghosts/hash.test.ts'], false)
    expect(prediction.verdict).toBe('ladder')
    expect(prediction.rule).toBe('doubt')
    expect(prediction.why).toEqual(['R1 scripts/ghosts/hash.ts: the ladder mechanism a task runs on'])
  })

  it('a code touch with no test beside it classifies not cheap', () => {
    expect(classifyTouches(['scripts/board/run.ts', 'CONTRIBUTING.md'], false)).toEqual({ verdict: 'ladder', rule: 'doubt', why: ['no test beside: scripts/board/run.ts'] })
  })

  it('a card with unclear lines classifies not cheap', () => {
    expect(classifyTouches(PLAN_TOUCHES[1041], true)).toEqual({ verdict: 'ladder', rule: 'doubt', why: ['the card carries unclear: lines'] })
  })

  it('a test touch is not a shrunk test, while a binary test diff still is', () => {
    expect(classifyTouches(['scripts/tests/board/run.test.ts'], false).rule).toBe('no-ground')
    expect(classify([{ path: 'tests/fixtures/logo.png', status: 'M', additions: null, deletions: null }]).rule).toBe('tests-shrunk')
  })
})
