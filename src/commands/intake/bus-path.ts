import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

export const BUS_DB_VARIABLE = 'CONSTRUCT_BUS_DB'

export function defaultBusPath(): string {
  return process.env[BUS_DB_VARIABLE] ?? path.join(os.homedir(), '.construct', 'bus.db')
}

export function busExpected(): boolean {
  return existsSync(defaultBusPath())
}
