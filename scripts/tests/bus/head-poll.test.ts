import { describe, expect, it } from 'vitest'
import { pollHead } from '../../bus/head-poll.js'

function reader(answers: (string | undefined | Error)[], log: string[]): () => string | undefined {
  return () => {
    log.push('read')
    const answer = answers.length > 1 ? answers.shift() : answers[0]
    if (answer instanceof Error)
      throw answer
    return answer
  }
}

describe('pollHead', () => {
  it('returns the first head that differs from the one before the update', () => {
    const log: string[] = []
    const poll = pollHead({ from: 'before', read: reader(['before', 'after', 'later'], log), settle: () => log.push('settle'), reads: 5 })
    expect(poll).toEqual({ kind: 'moved', head: 'after' })
    expect(log).toEqual(['read', 'settle', 'read'])
  })

  it('says the head did not move when a read succeeded and none moved', () => {
    const log: string[] = []
    const poll = pollHead({ from: 'before', read: reader([new Error('gh: rate limit'), 'before', undefined], log), settle: () => log.push('settle'), reads: 3 })
    expect(poll).toEqual({ kind: 'still' })
    expect(log).toEqual(['read', 'settle', 'read', 'settle', 'read'])
  })

  it('names the first line of the last read error when no read succeeded', () => {
    const log: string[] = []
    const poll = pollHead({ from: 'before', read: reader([new Error('gh: timeout'), new Error('gh: rate limit\nretry later')], log), settle: () => log.push('settle'), reads: 4 })
    expect(poll).toEqual({ kind: 'unread', error: 'gh: rate limit' })
    expect(log).toEqual(['read', 'settle', 'read', 'settle', 'read', 'settle', 'read'])
  })
})
