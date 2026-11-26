import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import * as factoryPaths from '../../core/factory-paths.js'
import * as places from '../../core/places.js'
import * as rules from '../../policy/morse/rules.js'
import * as diff from '../../ports/diff.js'

function importsOf(file: string): string[] {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8')
  return [...source.matchAll(/from '([^']+)'/g)].map(match => match[1])
}

describe('the diff shapes live in ports and the report paths in layout', () => {
  it('ports/diff.ts owns MorseRefusal and TOUCHED, and morse/rules.ts re-exports the same values', () => {
    expect(diff.TOUCHED).toBe('touch')
    expect(typeof diff.MorseRefusal).toBe('function')
    expect(rules.MorseRefusal).toBe(diff.MorseRefusal)
    expect(rules.TOUCHED).toBe(diff.TOUCHED)
  })

  it('core/factory-paths.ts owns reportPath and treeReportPath, and core/places.ts re-exports the same functions', () => {
    expect(factoryPaths.reportPath('/launch', '7')).toBe('/launch/report-7.md')
    expect(factoryPaths.treeReportPath('/tree')).toBe('/tree/.construct/report.md')
    expect(places.reportPath).toBe(factoryPaths.reportPath)
    expect(places.treeReportPath).toBe(factoryPaths.treeReportPath)
  })

  it('no port reaches up to morse/rules.ts or core/places.ts for these symbols', () => {
    expect(importsOf('../../ports/diff.ts')).not.toContain('../policy/morse/rules.js')
    expect(importsOf('../../ports/tree-publish.ts')).not.toContain('../core/places.js')
  })
})
