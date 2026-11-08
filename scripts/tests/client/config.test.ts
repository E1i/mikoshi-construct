import type { ClientRecord } from '../../../src/manifest.js'
import { describe, expect, it } from 'vitest'
import { CLIENT_ROLES, DEFAULT_CLIENT_MODEL } from '../../../src/manifest.js'
import { claudeAdapter } from '../../ports/client/claude/adapter.js'
import { codexAdapter } from '../../ports/client/codex/adapter.js'
import { clientAdapter, clientAdapterById, clientForRole } from '../../ports/client/index.js'

const UNKNOWN = 'no-such-client'

describe('client choice is configuration (D-323)', () => {
  it('no record gives the default adapter and auto for every role', () => {
    expect(DEFAULT_CLIENT_MODEL).toBe('auto')
    for (const role of CLIENT_ROLES) {
      expect(clientForRole(undefined, role)).toEqual({ adapter: claudeAdapter, model: 'auto' })
      expect(clientForRole({}, role)).toEqual({ adapter: claudeAdapter, model: 'auto' })
    }
  })

  it('clientAdapter() with no argument stays the default adapter', () => {
    expect(clientAdapter()).toBe(claudeAdapter)
  })

  it('looks an adapter up by its id', () => {
    expect(clientAdapterById(claudeAdapter.id)).toBe(claudeAdapter)
    expect(clientAdapterById(codexAdapter.id)).toBe(codexAdapter)
  })

  it('a role resolves to its adapter, over the record id, and carries the model', () => {
    const record: ClientRecord = { id: claudeAdapter.id, model: 'some-model', roles: { review: codexAdapter.id } }
    expect(clientForRole(record, 'review')).toEqual({ adapter: codexAdapter, model: 'some-model' })
    expect(clientForRole(record, 'launch')).toEqual({ adapter: claudeAdapter, model: 'some-model' })
    expect(clientForRole({ id: codexAdapter.id }, 'window')).toEqual({ adapter: codexAdapter, model: 'auto' })
  })

  it('an id with no adapter is a Refusal naming the id and the known ones', () => {
    const refusal = clientAdapterById(UNKNOWN)
    expect(refusal).toEqual({ kind: 'refused', reason: `no client adapter for id "${UNKNOWN}"; known: ${claudeAdapter.id}, ${codexAdapter.id}` })
    expect(clientForRole({ roles: { answer: UNKNOWN } }, 'answer')).toEqual(refusal)
    expect(clientForRole({ id: UNKNOWN }, 'launch')).toEqual(refusal)
  })
})
