import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { missingDiscovery } from '../src/commands/doctor/discovery.js'
import { upgradeManifest } from '../src/manifest.js'

const FROZEN = path.resolve(import.meta.dirname, 'fixtures/manifests/monorepo-0.1.0-names-replaced/construct.json')

const MODEL = 'id: app\ntitle: t\ndescription: d\ndoc: architecture/app.md\nboundaries: []\nnodes: []\nedges: []\n'

function repositoryWithModelsAt(where: string): string {
  const root = mkdtempSync(path.join(tmpdir(), 'construct-composition-'))
  mkdirSync(path.join(root, where), { recursive: true })
  writeFileSync(path.join(root, where, 'app.yaml'), MODEL)
  return root
}

function frozen(): ReturnType<typeof upgradeManifest> {
  return upgradeManifest(JSON.parse(readFileSync(FROZEN, 'utf8')))
}

describe('the composition marker is found where the repository keeps it', () => {
  it('reads a manifest that never recorded the directory, and finds the models anyway', () => {
    const root = repositoryWithModelsAt('docs/composition')
    expect(frozen().vars.compositionDir).toBeUndefined()
    expect(missingDiscovery(root, frozen())).not.toContain('composition')
  })

  it('still reports the marker missing when the repository keeps no models at all', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'construct-composition-'))
    expect(missingDiscovery(root, frozen())).toContain('composition')
  })

  it('prefers what the manifest decided over what the repository shows', () => {
    const root = repositoryWithModelsAt('docs/composition')
    const decided = { ...frozen(), vars: { ...frozen().vars, compositionDir: 'architecture/composition' } }
    expect(missingDiscovery(root, decided)).toContain('composition')
  })
})
