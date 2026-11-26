import type { ThermalAdapter, ThermalLevel } from '../host-thermal.js'
import { spawnSync } from 'node:child_process'

const NOTIFY_TOOL = 'notifyutil'
const PRESSURE_KEY = 'com.apple.system.thermalpressurelevel'
const READ_TIMEOUT_MS = 2_000
const NOMINAL = 0
const MODERATE = 1
const LEVEL_AT_END = /(\d+)\s*$/

export function macosThermalLevel(output: string): ThermalLevel {
  const match = LEVEL_AT_END.exec(output.trim())
  if (match === null)
    return 'unknown'
  const level = Number(match[1])
  if (level === NOMINAL)
    return 'nominal'
  return level === MODERATE ? 'moderate' : 'heavy'
}

function readPressure(): ThermalLevel {
  const run = spawnSync(NOTIFY_TOOL, ['-g', PRESSURE_KEY], { encoding: 'utf8', timeout: READ_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] })
  return run.status === 0 ? macosThermalLevel(run.stdout) : 'unknown'
}

export const MACOS_THERMAL: ThermalAdapter = { platform: 'darwin', read: readPressure }
