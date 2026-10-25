import type { Card } from '../../../src/card/grammar.js'
import type { DepthSources } from '../../nodes/review/review-depth.js'
import { describe, expect, it } from 'vitest'
import { parseCard } from '../../../src/card/grammar.js'
import { RISK_LEVELS } from '../../../src/card/risk.js'
import { isLadder, reviewBody } from '../../ladder/ladder.js'
import { REVIEW_DEPTHS, reviewDepth, reviewOf } from '../../ladder/verdict.js'
import { REVIEW_DEPTHS as BUS_REVIEW_DEPTHS, FULL_DEPTH_RULE, planReview } from '../../nodes/review/review-depth.js'
import { classify } from '../../policy/morse/rules.js'

function cardOf(line: string): Card {
  const parsed = parseCard(line)
  if (parsed.kind === 'refused')
    throw new Error(parsed.reason)
  return parsed.card
}

const LADDER_CARD = cardOf('#900 depth-card [implement/runner/S/ladder/auto] · depends — · blocks —')
const BRIEF = '/handoff/brief-900-depth-card.md'

const BY_RISK = [
  { touches: ['.claude/agents/review.md'], risk: 'R1', depth: 'full', step: 'blind Design scan' },
  { touches: ['scripts/window/**'], risk: 'R2', depth: 'full', step: 'blind Design scan' },
  { touches: ['src/atlas/**'], risk: 'R3', depth: 'diff', step: 'reads the diff only' },
  { touches: ['docs/cli.md', 'tests/x.test.ts'], risk: 'R4', depth: 'none', step: 'Launch no review agent' },
] as const

describe('review depth follows risk', () => {
  it('maps R4 to none, R3 to diff, R1 and R2 to full, and covers every level', () => {
    expect(RISK_LEVELS.map(reviewDepth)).toEqual(['full', 'full', 'diff', 'none'])
    expect(new Set(RISK_LEVELS.map(reviewDepth))).toEqual(new Set(REVIEW_DEPTHS))
  })

  it.each(BY_RISK)('a ladder card touching $touches is $risk and its review step runs depth $depth', ({ touches, risk, depth, step }) => {
    expect(isLadder(LADDER_CARD)).toBe(true)
    expect(reviewOf(touches)).toEqual({ risk, depth })
    const body = reviewBody(LADDER_CARD, BRIEF, reviewOf(touches))
    expect(body).toContain(`Review depth ${depth}, from risk ${risk}.`)
    expect(body).toContain(step)
    expect(body.includes('ghosts:verdict')).toBe(depth !== 'none')
  })
})

describe('no touches is a full review', () => {
  it('an empty set of touches or changed files reads R1 and a full review, never none', () => {
    expect(reviewOf([])).toEqual({ risk: 'R1', depth: 'full' })
    expect(reviewOf()).toEqual({ risk: 'R1', depth: 'full' })
    expect(reviewOf(['docs/cli.md'], [])).toEqual({ risk: 'R1', depth: 'full' })
  })

  it('the deeper of the touches and the changed files decides', () => {
    expect(reviewOf(['docs/cli.md'], ['docs/cli.md'])).toEqual({ risk: 'R4', depth: 'none' })
    expect(reviewOf(['docs/cli.md'], ['src/materialize/plan.ts'])).toEqual({ risk: 'R1', depth: 'full' })
  })
})

describe('bus review depth follows the MORSE instructions rule', () => {
  const BASE = 'b'.repeat(40)
  const HEAD = 'h'.repeat(40)
  const lease = { taskKey: `review:1974:974:${HEAD}`, queue: 'review' as const, cardId: 1974, pr: 974, head: HEAD, leaseGen: 1, actor: 'worker:review:w' }

  function sourcesOf(paths: string[], touches: string[]): DepthSources {
    return {
      base: () => BASE,
      changed: () => paths,
      predict: () => ({ prediction: classify(paths.map(file => ({ path: file, status: 'M', additions: 1, deletions: 0 }))), files: paths }),
      scope: () => ({ touches, runs: [] }),
    }
  }

  it.each([
    { paths: ['docs/cli.md'], rule: 'docs-only' },
    { paths: ['src/atlas/index.ts'], rule: 'src' },
    { paths: ['scripts/core/queue.ts'], rule: 'doubt' },
  ])('a bus review with no MORSE instructions rule runs at diff depth ($rule)', ({ paths, rule }) => {
    const plan = planReview(lease, null, sourcesOf(paths, paths))
    expect(plan).toEqual({ depth: 'diff', round: 'first', why: expect.stringContaining(`by rule ${rule}`), since: BASE, touchFindings: [] })
  })

  it('a bus review under the MORSE instructions rule runs at full depth', () => {
    const paths = ['.claude/agents/review.md', 'docs/cli.md']
    const plan = planReview(lease, null, sourcesOf(paths, paths))
    expect(plan).toMatchObject({ depth: 'full', prediction: { verdict: 'ladder', rule: FULL_DEPTH_RULE } })
    expect(BUS_REVIEW_DEPTHS).toEqual(['full', 'diff'])
  })
})
