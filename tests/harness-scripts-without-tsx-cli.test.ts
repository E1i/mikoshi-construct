import { describe, expect, it } from 'vitest'
import { availablePresets, PNPM_HARNESS, renderInit } from '../scripts/harness-command/render.js'

const MANIFEST = 'package.json'
const QUALITY = 'quality'
const TSX_CLI = /(?:^|&&|\|\||;|\|)\s*(?:pnpm\s+(?:exec\s+)?)?tsx\s/
const SCRIPT_REFERENCE = /pnpm\s+(?:run\s+)?([\w:-]+)/g
const LOADER_FORMS = {
  'composition:check': 'node --import tsx scripts/composition/check.ts',
  'composition:render': 'node --import tsx scripts/composition/sync-docs.ts',
}

function scriptsOf(presetId: Parameters<typeof renderInit>[0]): Record<string, string> {
  const manifest = JSON.parse(renderInit(presetId, PNPM_HARNESS).get(MANIFEST) ?? '{}') as { scripts?: Record<string, string> }
  return manifest.scripts ?? {}
}

function reachableFromQuality(scripts: Record<string, string>): string[] {
  const reached = new Set<string>()
  const pending = [QUALITY]
  while (pending.length > 0) {
    const name = pending.pop()!
    if (reached.has(name) || scripts[name] === undefined)
      continue
    reached.add(name)
    for (const [, referenced] of scripts[name].matchAll(SCRIPT_REFERENCE))
      pending.push(referenced)
  }
  return [...reached]
}

describe('the package.json scripts init writes run without the tsx CLI and its IPC socket', () => {
  for (const presetId of availablePresets()) {
    it(`${presetId}: no script reachable from quality invokes the tsx CLI`, () => {
      const scripts = scriptsOf(presetId)
      const invokingTheCli = reachableFromQuality(scripts).filter(name => TSX_CLI.test(scripts[name]))
      expect(invokingTheCli).toEqual([])
    })

    it(`${presetId}: composition:check and composition:render load tsx into node`, () => {
      const scripts = scriptsOf(presetId)
      for (const [name, form] of Object.entries(LOADER_FORMS))
        expect(scripts[name], name).toBe(form)
    })
  }
})
