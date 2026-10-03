import { describe, expect, it } from 'vitest'
import { cardHead, parseCard } from '../../ghosts/card.js'
import { MILESTONES } from '../../ghosts/milestones.js'

const VALID = '#123 task-card [implement/ghosts/M/cheap/owner] · depends #86, #90 · blocks #124 the board card'

describe('parseCard', () => {
  it('reads every field of a valid card and keeps the source line', () => {
    expect(parseCard(` ${VALID} `)).toEqual({
      kind: 'card',
      card: { id: 123, name: 'task-card', kind: 'implement', milestone: 'ghosts', size: 'M', contour: 'cheap', decision: 'owner', depends: [86, 90], blocks: [124], line: VALID },
    })
  })

  it('reads — as an empty list, and a free tail after blocks —', () => {
    const parsed = parseCard('#7 probe-it [probe/ice/XS/ladder/none] · depends — · blocks — a later board card')
    expect(parsed).toMatchObject({ kind: 'card', card: { kind: 'probe', decision: 'none', depends: [], blocks: [] } })
  })

  it('accepts every milestone of the list', () => {
    for (const milestone of MILESTONES)
      expect(parseCard(`#1 x [implement/${milestone}/S/cheap/auto] · depends — · blocks —`).kind).toBe('card')
  })

  it.each([
    ['an unknown milestone', '#1 x [implement/moon/S/cheap/auto] · depends — · blocks —', `milestone 'moon' is not one of ${MILESTONES.join(', ')}`],
    ['probe with decision owner', '#1 x [probe/ice/S/cheap/owner] · depends — · blocks —', 'kind probe takes decision none, not owner'],
    ['implement with decision none', '#1 x [implement/ice/S/cheap/none] · depends — · blocks —', 'kind implement takes decision owner or auto, not none'],
    ['a bad size', '#1 x [implement/ice/XL/cheap/auto] · depends — · blocks —', `size 'XL' is not one of XS, S, M, L`],
    ['no · depends', '#1 x [implement/ice/S/cheap/auto] · blocks —', `'· depends <#id …|—>' must follow '[implement/ice/S/cheap/auto]'`],
    ['no · blocks', '#1 x [implement/ice/S/cheap/auto] · depends —', `'· blocks <#id …|—>' must follow the depends list`],
    ['an id that is not a number', '#a1 x [implement/ice/S/cheap/auto] · depends — · blocks —', `id '#a1' is not a number`],
    ['a name that is not a slug', '#1 Task_Card [implement/ice/S/cheap/auto] · depends — · blocks —', `name 'Task_Card' must be a slug of a-z, 0-9 and '-'`],
    ['an unknown kind', '#1 x [build/ice/S/cheap/auto] · depends — · blocks —', `kind 'build' is not one of implement, probe`],
    ['an unknown contour', '#1 x [implement/ice/S/fast/auto] · depends — · blocks —', `contour 'fast' is not one of cheap, ladder`],
    ['four fields', '#1 x [implement/ice/S/cheap] · depends — · blocks —', `'[implement/ice/S/cheap]' must hold five fields: <kind>/<milestone>/<size>/<contour>/<decision>`],
    ['depends with a tail', '#1 x [implement/ice/S/cheap/auto] · depends #2 soon · blocks —', `depends '#2 soon' must be '#<id>' entries or '—'`],
    ['blocks with no id', '#1 x [implement/ice/S/cheap/auto] · depends — · blocks the board', `blocks 'the board' must start with '#<id>' entries or '—'`],
  ])('refuses %s with its reason', (_, line, reason) => {
    expect(parseCard(line)).toEqual({ kind: 'refused', reason })
  })

  it('refuses a line with no card head and names the grammar', () => {
    expect(parseCard('task-card')).toMatchObject({ kind: 'refused', reason: expect.stringContaining('a card is \'#<id> <name> [') })
  })
})

describe('cardHead', () => {
  it('prints #<id> <name> [<kind>/…] without the lists', () => {
    const parsed = parseCard(VALID)
    expect(parsed.kind === 'card' && cardHead(parsed.card)).toBe('#123 task-card [implement/ghosts/M/cheap/owner]')
  })
})
