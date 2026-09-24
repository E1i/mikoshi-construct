import type { SurfaceReading } from '../../scripts/contract/semantic-diff.js'
import type { Surface } from '../../scripts/contract/surface.js'
import { SURFACE_VERSION } from '../../scripts/contract/surface.js'

export function fixtureSurface(): Surface {
  return {
    surfaceVersion: SURFACE_VERSION,
    commands: {
      doctor: { flags: { dir: { type: 'string' }, json: { type: 'boolean' } } },
      init: { flags: { yes: { type: 'boolean', alias: 'y' } } },
      inspect: { aliasOf: 'doctor' },
    },
    exits: { doctor: { ok: 0, notOk: 1, noManifest: 1 } },
    jsonKeys: { doctor: { ok: { root: 'object', keys: ['ok', 'schemaVersion'] }, noManifest: { root: 'object', keys: ['schemaVersion'] } } },
    formats: { manifestVersion: 1, modelVersion: 1, recordVersion: 1 },
    paths: { init: { 'node-library': ['AGENTS.md', 'package.json'] }, attach: { writes: ['AGENTS.md'], edits: ['.git/info/exclude'] } },
    markers: { block: [['<!-- construct:begin -->', '<!-- construct:end -->']], discover: { tags: ['<!-- construct:discover:<marker> -->'], markers: ['product'] } },
    outside: ['lore strings'],
  }
}

export function reading(surface: Surface): SurfaceReading {
  const { surfaceVersion: _, ...sections } = surface
  return sections
}
