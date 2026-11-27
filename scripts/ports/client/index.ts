import type { ClientAdapter, ModelChoice, Refusal, Role, WindowCommand } from './contract.js'
import { codexAdapter } from './codex/adapter.js'

export interface ClientChoice {
  adapter: ClientAdapter
  model: ModelChoice
}

export interface ClientConfig {
  id: string | null
  model: ModelChoice
}

export type ClientConfigReader = (root: string, role: Role) => ClientConfig

export class ClientPort {
  constructor(private readonly defaultAdapter: ClientAdapter, private readonly configOf: ClientConfigReader) {}

  clientAdapterById(id: string): ClientAdapter | Refusal {
    return this.adapters().find(adapter => adapter.id === id) ?? this.noAdapterFor(id)
  }

  clientFor({ id, model }: ClientConfig): ClientChoice | Refusal {
    const adapter = id == null ? this.defaultAdapter : this.clientAdapterById(id)
    return 'kind' in adapter ? adapter : { adapter, model }
  }

  clientForRoleIn(root: string, role: Role): ClientChoice | Refusal {
    const config = this.configIn(root, role)
    return 'kind' in config ? config : this.clientFor(config)
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

  private configIn(root: string, role: Role): ClientConfig | Refusal {
    try {
      return this.configOf(root, role)
    }
    catch (error) {
      return { kind: 'refused', reason: `the client record of ${root} is unreadable: ${error instanceof Error ? error.message : String(error)}` }
    }
  }
}
