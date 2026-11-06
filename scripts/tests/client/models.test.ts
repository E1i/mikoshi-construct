import type { ModelOffer, Refusal, Role } from '../../ports/client/contract.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { claudeAdapter } from '../../ports/client/claude/adapter.js'
import { REVIEW_MODEL_VARIABLE, reviewModelOf } from '../../ports/session.js'

const ROLES_WITHOUT_A_MODEL_VARIABLE: Role[] = ['launch', 'answer', 'ladder', 'ghost', 'window']
const NOT_OFFERED = 'gpt-6-astra'
const BLANK = ' '
const OUTSIDE_THE_OFFERS = 'the-review-model'

afterEach(() => {
  vi.unstubAllEnvs()
})

function offers(): ModelOffer[] {
  const listed = claudeAdapter.models()
  expect(listed).not.toBeNull()
  return listed!
}

function offeredIds(): string[] {
  return offers().map(offer => offer.id)
}

describe('models', () => {
  it('offers every model name the repository sets today, with one offer per id', () => {
    const ids = offeredIds()
    expect(ids).toEqual(expect.arrayContaining(['sonnet', 'claude-sonnet-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5']))
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('says null for a context window the client does not report, and recommends no role', () => {
    for (const offer of offers())
      expect(offer).toMatchObject({ contextWindow: null, recommendedFor: [] })
  })

  it('offers every effort the client takes', () => {
    for (const offer of offers())
      expect(offer.efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  })
})

describe('modelFor with auto', () => {
  it('gives launch, answer and every other role an empty pick, whatever the review variable says', () => {
    vi.stubEnv(REVIEW_MODEL_VARIABLE, 'sonnet')
    for (const role of ROLES_WITHOUT_A_MODEL_VARIABLE)
      expect(claudeAdapter.modelFor(role, null, 'auto'), role).toEqual({ model: null, effort: null })
  })

  it.each([
    ['unset', undefined, null],
    ['blank', BLANK, null],
    ['an offered alias', 'sonnet', 'sonnet'],
    ['a name outside the offers', OUTSIDE_THE_OFFERS, OUTSIDE_THE_OFFERS],
  ])('gives review what reviewModelOf gives when the variable is %s', (_label, value, model) => {
    vi.stubEnv(REVIEW_MODEL_VARIABLE, value)
    expect(claudeAdapter.modelFor('review', null, 'auto')).toEqual({ model, effort: null })
    expect(reviewModelOf() ?? null).toBe(model)
  })

  it('reads the variable at each call, never at load', () => {
    vi.stubEnv(REVIEW_MODEL_VARIABLE, 'opus')
    expect(claudeAdapter.modelFor('review', null, 'auto')).toEqual({ model: 'opus', effort: null })
    vi.stubEnv(REVIEW_MODEL_VARIABLE, 'haiku')
    expect(claudeAdapter.modelFor('review', null, 'auto')).toEqual({ model: 'haiku', effort: null })
  })
})

describe('modelFor with a named model', () => {
  it('returns each offer as named, for every role and effort', () => {
    for (const id of offeredIds()) {
      expect(claudeAdapter.modelFor('launch', null, id)).toEqual({ model: id, effort: null })
      expect(claudeAdapter.modelFor('review', 'max', id)).toEqual({ model: id, effort: null })
    }
  })

  it('takes a named model over the review variable', () => {
    vi.stubEnv(REVIEW_MODEL_VARIABLE, 'sonnet')
    expect(claudeAdapter.modelFor('review', null, 'opus')).toEqual({ model: 'opus', effort: null })
  })

  it.each([NOT_OFFERED, 'Sonnet', '', BLANK])('refuses %j, naming it and every offer, and picks nothing', (wanted) => {
    const refusal = claudeAdapter.modelFor('launch', null, wanted) as Refusal
    expect(refusal.kind).toBe('refused')
    expect(refusal).not.toHaveProperty('model')
    expect(refusal.reason).toContain(`the model ${wanted} `)
    for (const id of offeredIds())
      expect(refusal.reason).toContain(id)
  })
})
