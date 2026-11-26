import process from 'node:process'
import { MACOS_THERMAL } from './host/macos-thermal.js'

export const THERMAL_LEVELS = ['nominal', 'moderate', 'heavy', 'unknown'] as const

export type ThermalLevel = typeof THERMAL_LEVELS[number]

export const HOST_HOT = 'host-hot'

export interface ThermalAdapter {
  platform: NodeJS.Platform
  read: () => ThermalLevel
}

export interface HostThermal {
  level: () => ThermalLevel
}

export const THERMAL_ADAPTERS: readonly ThermalAdapter[] = [MACOS_THERMAL]

export const THERMAL_READING_MS = 30_000

export function hostThermal(platform: NodeJS.Platform = process.platform, adapters: readonly ThermalAdapter[] = THERMAL_ADAPTERS, now: () => number = Date.now): HostThermal {
  const adapter = adapters.find(each => each.platform === platform)
  if (adapter === undefined)
    return { level: () => 'unknown' }
  let held: { level: ThermalLevel, at: number } | null = null
  return {
    level: () => {
      const at = now()
      if (held !== null && at - held.at < THERMAL_READING_MS)
        return held.level
      let level: ThermalLevel
      try {
        level = adapter.read()
      }
      catch {
        level = 'unknown'
      }
      held = { level, at }
      return level
    },
  }
}

export const HOST_THERMAL: HostThermal = hostThermal()

export const UNREAD_THERMAL: HostThermal = { level: () => 'unknown' }

export function fixedThermal(level: ThermalLevel): HostThermal {
  return { level: () => level }
}

export function thermalFree(free: number, level: ThermalLevel): number {
  if (level === 'heavy')
    return 0
  return level === 'moderate' ? Math.floor(free / 2) : free
}

export function hostHotLine(level: ThermalLevel): string {
  return `${HOST_HOT}: the host reports thermal pressure ${level}; launch starts no session, gate, generator or git until it falls back, and no card is stopped for it`
}
