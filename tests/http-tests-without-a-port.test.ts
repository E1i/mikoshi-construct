import { describe, expect, it } from 'vitest'
import { availablePresets, PNPM_HARNESS, renderInit } from '../scripts/harness-command/render.js'

const PORT_BINDING_LIBRARIES = ['supertest', '@types/supertest']
const IN_MEMORY_TRANSPORT = 'light-my-request'
const HTTP_APP_MANIFESTS: Record<string, string> = {
  'node-backend': 'package.json',
  'monorepo': 'apps/api/package.json',
}

interface Manifest {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

function declaredDependencies(manifest: Manifest): string[] {
  return [...Object.keys(manifest.dependencies ?? {}), ...Object.keys(manifest.devDependencies ?? {})]
}

function renderedManifests(presetId: Parameters<typeof renderInit>[0]): Map<string, Manifest> {
  const manifests = new Map<string, Manifest>()
  for (const [file, content] of renderInit(presetId, PNPM_HARNESS)) {
    if (file === 'package.json' || file.endsWith('/package.json'))
      manifests.set(file, JSON.parse(content) as Manifest)
  }
  return manifests
}

describe('the HTTP tests init writes run in memory, without binding a port', () => {
  for (const presetId of availablePresets()) {
    it(`${presetId}: no rendered package.json carries a port-binding test client`, () => {
      for (const [file, manifest] of renderedManifests(presetId)) {
        const binding = declaredDependencies(manifest).filter(name => PORT_BINDING_LIBRARIES.includes(name))
        expect(binding, file).toEqual([])
      }
    })
  }

  for (const [presetId, file] of Object.entries(HTTP_APP_MANIFESTS)) {
    it(`${presetId}: ${file} carries the in-memory transport`, () => {
      const manifest = renderedManifests(presetId as Parameters<typeof renderInit>[0]).get(file)
      expect(manifest, file).toBeDefined()
      expect(manifest?.devDependencies?.[IN_MEMORY_TRANSPORT], file).toBeDefined()
    })
  }

  it('the monorepo catalog pins the in-memory transport to the node-backend range', () => {
    const workspace = renderInit('monorepo', PNPM_HARNESS).get('pnpm-workspace.yaml') ?? ''
    const backendRange = renderedManifests('node-backend').get('package.json')?.devDependencies?.[IN_MEMORY_TRANSPORT]
    expect(workspace).toContain(`  ${IN_MEMORY_TRANSPORT}: ${backendRange}\n`)
  })
})
