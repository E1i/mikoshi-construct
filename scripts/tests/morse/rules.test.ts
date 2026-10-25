import type { Prediction, RuleId } from '../../policy/morse/rules.js'
import { describe, expect, it } from 'vitest'
import { classify, classifyTouches, RULES } from '../../policy/morse/rules.js'

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
    const prediction = classifyTouches(['scripts/ladder/hash.ts', 'scripts/tests/ghosts/hash.test.ts'], false)
    expect(prediction.verdict).toBe('ladder')
    expect(prediction.rule).toBe('doubt')
    expect(prediction.why).toEqual(['R1 scripts/ladder/hash.ts: the ladder mechanism a task runs on'])
  })

  it('a code touch with no test beside it classifies not cheap', () => {
    expect(classifyTouches(['scripts/board/run.ts', 'CONTRIBUTING.md'], false)).toEqual({ verdict: 'ladder', rule: 'doubt', why: ['no test beside: scripts/board/run.ts'] })
  })

  it('a card with unclear lines classifies not cheap', () => {
    expect(classifyTouches(PLAN_TOUCHES[1041], true)).toEqual({ verdict: 'ladder', rule: 'doubt', why: ['the card carries unclear: lines'] })
  })

  it('an src edit with a test beside classifies cheap', () => {
    const files = [
      { path: 'src/ui/lore.ts', status: 'M' as const, additions: 4, deletions: 1 },
      { path: 'tests/lore.test.ts', status: 'M' as const, additions: 6, deletions: 0 },
    ]
    expect(classify(files).verdict).toBe('cheap')
  })

  it('deletion cards #1038, #1039, #1041 classify cheap', () => {
    const removed = (path: string) => ({ path, status: 'D' as const, additions: 0, deletions: 10 })
    const edited = (path: string) => ({ path, status: 'M' as const, additions: 0, deletions: 3 })
    const shared = ['package.json', 'tests/harness-membership.test.ts', 'CONTRIBUTING.md', 'scripts/ci/test-weights.json'].map(edited)
    const cards = [
      [removed('scripts/morse/backtest.ts'), removed('scripts/shift/answer-record.ts'), removed('scripts/tests/shift/answer-record.test.ts'), edited('scripts/morse/cli.ts'), edited('scripts/tests/morse/cli.test.ts'), ...shared],
      [removed('scripts/bench/run.ts'), removed('scripts/tests/bench/run.test.ts'), ...shared],
      [removed('scripts/board/run.ts'), removed('scripts/tests/board/run.test.ts'), ...shared],
    ]
    for (const files of cards)
      expect(classify(files).verdict).toBe('cheap')
  })

  it('a card with an R1 touch does not classify cheap', () => {
    const files = [
      { path: 'scripts/ladder/hash.ts', status: 'M' as const, additions: 2, deletions: 1 },
      { path: 'scripts/tests/ghosts/hash.test.ts', status: 'M' as const, additions: 3, deletions: 0 },
    ]
    expect(classify(files).verdict).toBe('ladder')
  })

  it('a test touch is not a shrunk test, while a binary test diff still is', () => {
    expect(classifyTouches(['scripts/tests/board/run.test.ts'], false).rule).toBe('no-ground')
    expect(classify([{ path: 'tests/fixtures/logo.png', status: 'M', additions: null, deletions: null }]).rule).toBe('tests-shrunk')
  })
})
