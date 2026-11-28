export const DEFAULT_CLIENT_MODEL = 'auto'

export const CLIENT_ROLES = ['launch', 'answer', 'review', 'window'] as const
export type ClientRole = (typeof CLIENT_ROLES)[number]

export interface ClientRecord {
  id?: string
  model?: string
  roles?: Partial<Record<ClientRole, string>>
}

export function clientIdFor(record: ClientRecord | undefined, role: ClientRole): string | null {
  return record?.roles?.[role] ?? record?.id ?? null
}

export function clientModelOf(record: ClientRecord | undefined): string {
  return record?.model ?? DEFAULT_CLIENT_MODEL
}
