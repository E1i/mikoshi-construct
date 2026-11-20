import type { ClientRecord, ClientRole } from '../../../src/manifest.js'
import type { ClientAdapter, ModelChoice, Refusal, WindowCommand } from './contract.js'
import { clientIdFor, clientModelOf, readManifest } from '../../../src/manifest.js'
import { settingsFlag, shiftSettings } from '../shift-settings.js'
import { claudeAdapterWith } from './claude/adapter.js'
import { codexAdapter } from './codex/adapter.js'

export interface ClientChoice {
  adapter: ClientAdapter
  model: ModelChoice
}

let builtDefaultAdapter: ClientAdapter | undefined

function adapters(): readonly ClientAdapter[] {
  return [clientAdapter(), codexAdapter]
}

function noAdapterFor(id: string): Refusal {
  return { kind: 'refused', reason: `no client adapter for id ${JSON.stringify(id)}; known: ${adapters().map(adapter => adapter.id).join(', ')}` }
}

export function clientAdapter(): ClientAdapter {
  builtDefaultAdapter ??= claudeAdapterWith({ shiftSettings, settingsFlag })
  return builtDefaultAdapter
}

export function clientAdapterById(id: string): ClientAdapter | Refusal {
  return adapters().find(adapter => adapter.id === id) ?? noAdapterFor(id)
}

export function clientForRole(record: ClientRecord | undefined, role: ClientRole): ClientChoice | Refusal {
  const id = clientIdFor(record, role)
  const adapter = id == null ? clientAdapter() : clientAdapterById(id)
  return 'kind' in adapter ? adapter : { adapter, model: clientModelOf(record) }
}

function recordedClientIn(root: string): ClientRecord | undefined | Refusal {
  try {
    return readManifest(root)?.client
  }
  catch (error) {
    return { kind: 'refused', reason: `the client record of ${root} is unreadable: ${error instanceof Error ? error.message : String(error)}` }
  }
}

export function clientForRoleIn(root: string, role: ClientRole): ClientChoice | Refusal {
  const record = recordedClientIn(root)
  return record !== undefined && 'kind' in record ? record : clientForRole(record, role)
}

export function windowCommandIn(root: string): WindowCommand | Refusal {
  const choice = clientForRoleIn(root, 'window')
  return 'kind' in choice ? choice : choice.adapter.window()
}

export function defaultWindowCommand(): WindowCommand {
  const window = clientAdapter().window()
  if ('kind' in window)
    throw new Error(window.reason)
  return window
}
