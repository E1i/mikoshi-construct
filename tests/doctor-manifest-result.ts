import type { AttachedReport, DoctorResult } from '../src/commands/doctor/index.js'

export function manifestResult(result: DoctorResult | AttachedReport | null): DoctorResult {
  if (result == null || 'state' in result)
    throw new Error(`doctor was expected to read construct.json, and read ${result == null ? 'no-manifest' : result.state}`)
  return result
}
