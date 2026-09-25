import type { Manifest } from '../../manifest.js'
import { recordedShas } from '../../manifest.js'
import { matchesAnyGlob } from '../../model/glob.js'
import { FileReadings } from './readings.js'
import { includeGlobs, RUNNER_CONFIG_FILES } from './runner.js'

const TEST_FILE = /\.test\.[cm]?[jt]s$/

export function uncollectedTests(root: string, manifest: Manifest, readings: FileReadings = new FileReadings(root)): string[] {
  const recorded = recordedShas(manifest)
  const config = RUNNER_CONFIG_FILES.find(candidate => recorded[candidate] != null)
  if (config == null)
    return []
  const source = readings.read(config)
  if (source == null)
    return []
  const globs = includeGlobs(source)
  if (globs == null)
    return []
  return Object.keys(recorded)
    .filter(file => TEST_FILE.test(file) && !matchesAnyGlob(file, globs))
    .sort()
}
