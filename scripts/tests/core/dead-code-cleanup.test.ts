import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..')

const DELETED_MODULES = [
  'scripts/intake/parking.ts',
  'scripts/intake/slice-parent-backfill.ts',
  'scripts/intake/runs-layers-backfill.ts',
  'scripts/cli/no-layer-recount.ts',
  'scripts/window/session-load.ts',
  'scripts/window/start-context.ts',
]

const DELETED_TESTS = [
  'scripts/tests/shift/parking.test.ts',
  'scripts/tests/shift/parking-merged.test.ts',
  'scripts/tests/shift/parking-stops.test.ts',
  'scripts/tests/intake/slice-parent-backfill.test.ts',
  'scripts/tests/intake/runs-layers-backfill.test.ts',
  'scripts/tests/core/no-layer-recount.test.ts',
  'scripts/tests/window/session-load.test.ts',
  'scripts/tests/client/start-context.test.ts',
]

const REGISTRIES = [
  'declarations/entries/shift.json',
  'declarations/modules/card-record.json',
  'declarations/modules/quality.json',
  'scripts/core/layer-map.json',
  'scripts/core/factory-paths.ts',
  'scripts/contract/factory/module-owns.ts',
  'scripts/ci/test-weights.json',
  'contract/module-files.json',
  'contract/factory.json',
  'construct.model.json',
  'architecture/lanes.md',
  'architecture/ghosts-files.md',
  '.changeset/slice-knows-its-parent.md',
  '.changeset/window-start-diet.md',
]

const UNUSED_DETECT_TYPES = ['ExistingFiles', 'Layout', 'MonorepoTool', 'PackageManager', 'WorkspacePackage']
const TYPE_REEXPORT = /export type \{([^}]*)\} from/g

function source(file: string): string {
  return readFileSync(path.join(REPO_ROOT, file), 'utf8')
}

function moduleStem(file: string): string {
  return path.basename(file, '.ts')
}

function namesAPath(text: string, file: string): boolean {
  const relative = file.replace(/^scripts\//, '')
  return text.includes(file) || text.includes(`/${relative}`) || text.includes(`${path.dirname(relative)}/${moduleStem(file)}.`)
}

describe('dead-code cleanup of D-665', () => {
  it('the modules D-665 deleted are gone from the tree and from every registry', () => {
    for (const file of [...DELETED_MODULES, ...DELETED_TESTS])
      expect(existsSync(path.join(REPO_ROOT, file)), file).toBe(false)
    expect(existsSync(path.join(REPO_ROOT, 'declarations/entries/layerIntakeParking.json'))).toBe(false)
    for (const registry of REGISTRIES) {
      const text = source(registry)
      for (const file of [...DELETED_MODULES, ...DELETED_TESTS])
        expect(namesAPath(text, file), `${registry} names ${file}`).toBe(false)
    }
  })

  it('src/detect/index.ts re-exports no type that nothing imports through it', () => {
    const reexported = [...source('src/detect/index.ts').matchAll(TYPE_REEXPORT)].flatMap(match => match[1]!.split(',').map(name => name.trim()))
    for (const name of UNUSED_DETECT_TYPES)
      expect(reexported, name).not.toContain(name)
    expect(reexported).toEqual(['DetectReport'])
  })
})
