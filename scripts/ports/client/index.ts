import type { ClientAdapter, ClientRecord, ClientRole, ModelChoice, Refusal, WindowCommand } from './contract.js'
import { codexAdapter } from './codex/adapter.js'
import { clientIdFor, clientModelOf } from './contract.js'

export interface ClientChoice {
  adapter: ClientAdapter
  model: ModelChoice
}

export type ClientRecordReader = (root: string) => ClientRecord | undefined

export class ClientPort {
  constructor(private readonly defaultAdapter: ClientAdapter, private readonly recordOf: ClientRecordReader) {}

  clientAdapterById(id: string): ClientAdapter | Refusal {
    return this.adapters().find(adapter => adapter.id === id) ?? this.noAdapterFor(id)
  }

  clientForRole(record: ClientRecord | undefined, role: ClientRole): ClientChoice | Refusal {
    const id = clientIdFor(record, role)
    const adapter = id == null ? this.defaultAdapter : this.clientAdapterById(id)
    return 'kind' in adapter ? adapter : { adapter, model: clientModelOf(record) }
  }

  clientForRoleIn(root: string, role: ClientRole): ClientChoice | Refusal {
    const record = this.recordedClientIn(root)
    return record !== undefined && 'kind' in record ? record : this.clientForRole(record, role)
  }

  windowCommandIn(root: string): WindowCommand | Refusal {
    const choice = this.clientForRoleIn(root, 'window')
    return 'kind' in choice ? choice : choice.adapter.window()
  }

  defaultWindowCommand(): WindowCommand {
    const window = this.defaultAdapter.window()
    if ('kind' in window)
      throw new Error(window.reason)
    return window
  }

  private adapters(): readonly ClientAdapter[] {
    return [this.defaultAdapter, codexAdapter]
  }

  private noAdapterFor(id: string): Refusal {
    return { kind: 'refused', reason: `no client adapter for id ${JSON.stringify(id)}; known: ${this.adapters().map(adapter => adapter.id).join(', ')}` }
  }

  private recordedClientIn(root: string): ClientRecord | undefined | Refusal {
    try {
      return this.recordOf(root)
    }
    catch (error) {
      return { kind: 'refused', reason: `the client record of ${root} is unreadable: ${error instanceof Error ? error.message : String(error)}` }
    }
  }
}
