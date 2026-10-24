import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { BUS_DB_VARIABLE, BUS_FILE, repoHome, repoIdOf } from '../../../scripts/core/bus-path.js'

export interface FactoryBeside {
  home: string
  createdFrom: string
}

export function factoryHomeFor(root: string, env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string | null {
  const named = env[BUS_DB_VARIABLE]
  if (named !== undefined && named !== '')
    return null
  return repoHome(home, repoIdOf(root))
}

export function deployFactoryBeside(root: string, env: NodeJS.ProcessEnv = process.env, home: string = homedir()): FactoryBeside | undefined {
  const factoryHome = factoryHomeFor(root, env, home)
  if (factoryHome == null || existsSync(factoryHome))
    return undefined
  const createdFrom = mkdirSync(factoryHome, { recursive: true }) ?? factoryHome
  writeFileSync(path.join(factoryHome, BUS_FILE), '', { flag: 'wx' })
  return { home: factoryHome, createdFrom }
}
