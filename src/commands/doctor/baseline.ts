import type { Manifest } from '../../manifest.js'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { sha256 } from '../../manifest.js'
import { FileReadings } from './readings.js'

export interface BaselineVerdict {
  missingFiles: string[]
  modifiedFiles: string[]
}

export function baselineVerdict(root: string, manifest: Manifest, readings: FileReadings = new FileReadings(root)): BaselineVerdict {
  const missingFiles: string[] = []
  const modifiedFiles: string[] = []
  for (const [file, hash] of Object.entries(manifest.files)) {
    if (!existsSync(path.join(root, file))) {
      missingFiles.push(file)
      continue
    }
    const content = readings.read(file)
    if (content != null && sha256(content) !== hash)
      modifiedFiles.push(file)
  }
  return { missingFiles, modifiedFiles }
}
