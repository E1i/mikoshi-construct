import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import * as factoryPaths from '../../core/factory-paths.js'

function sourceOf(file: string): string {
  return readFileSync(new URL(file, import.meta.url), 'utf8')
}

function importsOf(file: string): string[] {
  return [...sourceOf(file).matchAll(/from '([^']+)'/g)].map(match => match[1])
}

describe('the diff shapes live in ports and the report paths in layout', () => {
  it('ports/diff.ts declares MorseRefusal, TOUCHED, ChangedFile and FileStatus, and morse/rules.ts re-exports them from there', () => {
    const diff = sourceOf('../../ports/diff.ts')
    const rules = sourceOf('../../policy/morse/rules.ts')
    expect(diff).toContain('export class MorseRefusal extends Error {}')
    expect(diff).toContain('export const TOUCHED = \'touch\'')
    expect(diff).toContain('export interface ChangedFile {')
    expect(diff).toContain('export type FileStatus = ')
    expect(rules).toContain('export { MorseRefusal, TOUCHED } from \'../../ports/diff.js\'')
    expect(rules).toContain('export type { ChangedFile, FileStatus } from \'../../ports/diff.js\'')
    expect(rules).not.toMatch(/export (?:class MorseRefusal|const TOUCHED|interface ChangedFile|type FileStatus =)/)
  })

  it('core/factory-paths.ts owns reportPath and treeReportPath, and core/places.ts re-exports them from there', () => {
    expect(factoryPaths.reportPath('/launch', '7')).toBe('/launch/report-7.md')
    expect(factoryPaths.treeReportPath('/tree')).toBe('/tree/.construct/report.md')
    const places = sourceOf('../../core/places.ts')
    expect(places).toContain('export { reportPath, treeReportPath } from \'./factory-paths.js\'')
    expect(places).not.toMatch(/export function (?:reportPath|treeReportPath)\(/)
  })

  it('no port reaches up to morse/rules.ts or core/places.ts for these symbols', () => {
    expect(importsOf('../../ports/diff.ts')).not.toContain('../policy/morse/rules.js')
    expect(importsOf('../../ports/tree-publish.ts')).not.toContain('../core/places.js')
  })
})
