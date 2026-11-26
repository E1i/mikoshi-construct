import type { DatabaseSync } from 'node:sqlite'

export interface WindowRoleRow {
  role: string
  status: string
  state: string
}

export function windowRoleRows(db: DatabaseSync): WindowRoleRow[] {
  return db.prepare('SELECT role, status, state FROM roles ORDER BY role').all() as unknown as WindowRoleRow[]
}
