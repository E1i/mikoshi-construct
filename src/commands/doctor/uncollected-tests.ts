import type { Manifest } from '../../manifest.js'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { includeGlobs, matchesAnyGlob, RUNNER_CONFIG_FILES } from './runner.js'

const TEST_FILE = /\.test\.[cm]?[jt]s$/

export function uncollectedTests(root: string, manifest: Manifest): string[] {
  const config = RUNNER_CONFIG_FILES.find(candidate => manifest.files[candidate] != null)
  if (config == null)
    return []
  let source: string
  try {
    source = readFileSync(path.join(root, config), 'utf8')
  }
  catch {
    return []
  }
  const globs = includeGlobs(source)
  if (globs == null)
    return []
  return Object.keys(manifest.files)
    .filter(file => TEST_FILE.test(file) && !matchesAnyGlob(file, globs))
    .sort()
}
