import type { ClientRecord } from '../../../src/manifest.js'
import { describe, expect, it } from 'vitest'
import { CLIENT_IDS, CLIENT_ROLES, DEFAULT_CLIENT_MODEL } from '../../../src/manifest.js'
import { codexAdapter } from '../../ports/client/codex/adapter.js'
import { ClientPort } from '../../ports/client/index.js'
import { clientAdapter } from '../../ports/session.js'

const claudeAdapter = clientAdapter()

const UNKNOWN = 'no-such-client'

const RECORD_OF_ROOT: Record<string, ClientRecord | undefined> = { '/a-repository': { roles: { window: 'codex' } } }

const port = new ClientPort(claudeAdapter, root => RECORD_OF_ROOT[root])

function clientAdapterById(id: string): ReturnType<ClientPort['clientAdapterById']> {
  return port.clientAdapterById(id)
}

function clientForRole(...args: Parameters<ClientPort['clientForRole']>): ReturnType<ClientPort['clientForRole']> {
  return port.clientForRole(...args)
}

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

  it('the adapters carry exactly the ids the record and doctor know', () => {
    expect([claudeAdapter.id, codexAdapter.id]).toEqual([...CLIENT_IDS])
    expect(clientAdapterById(UNKNOWN)).toEqual({ kind: 'refused', reason: expect.stringContaining(`known: ${CLIENT_IDS.join(', ')}`) })
  })

  it('an id with no adapter is a Refusal naming the id and the known ones', () => {
    const refusal = clientAdapterById(UNKNOWN)
    expect(refusal).toEqual({ kind: 'refused', reason: `no client adapter for id "${UNKNOWN}"; known: ${claudeAdapter.id}, ${codexAdapter.id}` })
    expect(clientForRole({ roles: { answer: UNKNOWN } }, 'answer')).toEqual(refusal)
    expect(clientForRole({ id: UNKNOWN }, 'launch')).toEqual(refusal)
  })

  it('reads the record of a root only through the reader its builder hands it', () => {
    expect(port.clientForRoleIn('/a-repository', 'window')).toEqual({ adapter: codexAdapter, model: 'auto' })
    expect(port.clientForRoleIn('/another-repository', 'window')).toEqual({ adapter: claudeAdapter, model: 'auto' })
    expect(port.windowCommandIn('/a-repository')).toEqual(codexAdapter.window())
  })

  it('a reader that throws becomes a Refusal naming the root', () => {
    const unreadable = new ClientPort(claudeAdapter, () => {
      throw new Error('broken record')
    })
    expect(unreadable.clientForRoleIn('/a-repository', 'launch')).toEqual({ kind: 'refused', reason: 'the client record of /a-repository is unreadable: broken record' })
  })
})
