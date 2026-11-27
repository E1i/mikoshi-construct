import type { ThermalAdapter } from '../../ports/host-thermal.js'
import { describe, expect, it } from 'vitest'
import { hostThermal, THERMAL_ADAPTERS, THERMAL_READING_MS, thermalFree } from '../../ports/host-thermal.js'
import { MACOS_THERMAL, macosThermalLevel } from '../../ports/host/macos-thermal.js'

describe('the host thermal port', () => {
  it('a host with no thermal adapter reports unknown and launch falls back to load', () => {
    expect(hostThermal('linux').level()).toBe('unknown')
    expect(hostThermal('win32').level()).toBe('unknown')
    expect(thermalFree(3, 'unknown')).toBe(3)
    expect(THERMAL_ADAPTERS.map(adapter => adapter.platform)).toEqual(['darwin'])
    expect(MACOS_THERMAL.platform).toBe('darwin')
  })

  it('the macOS adapter reads the pressure level notifyutil reports', () => {
    expect(macosThermalLevel('com.apple.system.thermalpressurelevel 0\n')).toBe('nominal')
    expect(macosThermalLevel('com.apple.system.thermalpressurelevel 1\n')).toBe('moderate')
    expect(macosThermalLevel('com.apple.system.thermalpressurelevel 2\n')).toBe('heavy')
    expect(macosThermalLevel('com.apple.system.thermalpressurelevel 3\n')).toBe('heavy')
    expect(macosThermalLevel('')).toBe('unknown')
  })

  it('a reading is held for its period and a failing adapter reads unknown', () => {
    let reads = 0
    let now = 0
    const adapter: ThermalAdapter = { platform: 'darwin', read: () => {
      reads += 1
      if (reads === 3)
        throw new Error('notifyutil is gone')
      return 'moderate'
    } }
    const thermal = hostThermal('darwin', [adapter], () => now)

    expect([thermal.level(), thermal.level()]).toEqual(['moderate', 'moderate'])
    expect(reads).toBe(1)
    now += THERMAL_READING_MS
    expect(thermal.level()).toBe('moderate')
    now += THERMAL_READING_MS
    expect(thermal.level()).toBe('unknown')
  })
})
