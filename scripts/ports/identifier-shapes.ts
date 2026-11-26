import { createHash } from 'node:crypto'

export const MAIN_BRANCH = 'main'

const FULL_SHA = /^[0-9a-f]{40}$/
const LEADING_NUMBER = /^#?(\d+)(?!\d)/
const CARD_PREFIX = /^card:\s*/

export function isFullSha(value: unknown): value is string {
  return typeof value === 'string' && FULL_SHA.test(value)
}

export function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null
}

export function cardIdOf(value: unknown): number | null {
  if (typeof value === 'number')
    return positiveInteger(value)
  if (typeof value === 'string') {
    const match = LEADING_NUMBER.exec(value.trim())
    return match === null ? null : positiveInteger(Number(match[1]))
  }
  if (value !== null && typeof value === 'object' && 'id' in value)
    return cardIdOf((value as { id: unknown }).id)
  return null
}

export function cardIdOfDescription(description: string | null | undefined): number | null {
  return cardIdOf((description ?? '').split('\n')[0]?.trim().replace(CARD_PREFIX, '') ?? '')
}

export function prBodySha(body: string | null | undefined): string {
  return createHash('sha256').update(body ?? '').digest('hex')
}
