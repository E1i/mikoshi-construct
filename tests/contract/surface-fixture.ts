import type { SurfaceReading } from '../../scripts/contract/semantic-diff.js'
import type { Surface } from '../../scripts/contract/surface.js'
import { REFUSAL_NOT_READ, SURFACE_VERSION } from '../../scripts/contract/surface.js'

export function fixtureSurface(): Surface {
  return {
    surfaceVersion: SURFACE_VERSION,
    commands: {
      doctor: { flags: { dir: { type: 'string' }, json: { type: 'boolean' } } },
      init: { flags: { yes: { type: 'boolean', alias: 'y' } } },
      inspect: { aliasOf: 'doctor' },
    },
    exits: { doctor: { ok: 0, notOk: 1, noManifest: 1 }, init: { written: 0, failed: 1 } },
    jsonKeys: { doctor: { ok: { root: 'object', keys: ['ok', 'schemaVersion'] }, noManifest: { root: 'object', keys: ['schemaVersion'] } } },
    jsonForms: { doctor: ['--json'] },
    unknownFlag: { doctor: 1, init: 1 },
    formats: { manifestVersion: 1, modelVersion: 1, recordVersion: 1 },
    paths: { init: { 'node-library': ['AGENTS.md', 'package.json'] }, attach: { writes: ['AGENTS.md'], edits: ['.git/info/exclude'] } },
    markers: { block: [['<!-- construct:begin -->', '<!-- construct:end -->']], discover: { tags: ['<!-- construct:discover:<marker> -->'], markers: ['product'] } },
    contours: { 'ledger-row': 'mikoshi-construct/contours/ledger-row/1' },
    outside: ['lore strings'],
    scripts: { quality: { entries: ['scripts/quality/lock.ts'], flags: [], json: false, exits: [], unknownFlag: REFUSAL_NOT_READ } },
    report: { countLine: '■ \\d+ □ \\d+ · \\d+', countLineRefusal: 'no_matrix_count_line', countLineUnder: ['src/'], readFrom: 'pull request description', writtenIn: '.construct/report.md', reportVersion: 1 },
  }
}

export function reading(surface: Surface): SurfaceReading {
  const { surfaceVersion: _, scripts: __, ...sections } = surface
  return sections
}
