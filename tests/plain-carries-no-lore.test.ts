import { describe, expect, it } from 'vitest'
import { LORE, PLAIN_LORE } from '../src/ui/lore.js'
import { IN_UNIVERSE, SHARED_BY_BOTH_REGISTERS } from './lore-vocabulary.js'

function strings(lore: typeof LORE): { key: string, value: string }[] {
  return Object.entries(lore)
    .filter(([, value]) => typeof value === 'string')
    .map(([key, value]) => ({ key, value: value as string }))
}

describe('the plain register carries none of the in-universe vocabulary', () => {
  it('names vocabulary the lore actually uses, so the list is not guarding a language nobody speaks', () => {
    const spoken = strings(LORE).map(entry => entry.value.toUpperCase()).join('\n')
    const unused = IN_UNIVERSE.filter(word => !spoken.includes(word.toUpperCase()))
    expect(unused).toEqual([])
  })

  it('names its exemption rather than filtering it away', () => {
    for (const key of SHARED_BY_BOTH_REGISTERS) {
      const lore = (LORE as unknown as Record<string, unknown>)[key]
      const plain = (PLAIN_LORE as unknown as Record<string, unknown>)[key]
      expect(plain, key).toBe(lore)
    }
  })

  it('keeps every one of those words out of every plain string', () => {
    for (const { key, value } of strings(PLAIN_LORE).filter(entry => !SHARED_BY_BOTH_REGISTERS.includes(entry.key))) {
      for (const word of IN_UNIVERSE)
        expect(value.toUpperCase(), `${key}: ${value}`).not.toContain(word.toUpperCase())
    }
  })

  it('gives every lore key a plain counterpart of the same kind', () => {
    for (const [key, value] of Object.entries(LORE))
      expect(typeof (PLAIN_LORE as unknown as Record<string, unknown>)[key], key).toBe(typeof value)
  })
})
