import type { ClientRecord, ClientRole } from '../../../src/manifest.js'
import type { ClientAdapter, ModelChoice, Refusal } from './contract.js'
import { clientIdFor, clientModelOf } from '../../../src/manifest.js'
import { claudeAdapter } from './claude/adapter.js'
import { codexAdapter } from './codex/adapter.js'

export interface ClientChoice {
  adapter: ClientAdapter
  model: ModelChoice
}

function adapters(): readonly ClientAdapter[] {
  return [claudeAdapter, codexAdapter]
}

function noAdapterFor(id: string): Refusal {
  return { kind: 'refused', reason: `no client adapter for id ${JSON.stringify(id)}; known: ${adapters().map(adapter => adapter.id).join(', ')}` }
}

export function clientAdapter(): ClientAdapter {
  return claudeAdapter
}

export function clientAdapterById(id: string): ClientAdapter | Refusal {
  return adapters().find(adapter => adapter.id === id) ?? noAdapterFor(id)
}

export function clientForRole(record: ClientRecord | undefined, role: ClientRole): ClientChoice | Refusal {
  const id = clientIdFor(record, role)
  const adapter = id == null ? clientAdapter() : clientAdapterById(id)
  return 'kind' in adapter ? adapter : { adapter, model: clientModelOf(record) }
}
