import type { Manifest } from '../../manifest.js'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { recordedShas, sha256 } from '../../manifest.js'
import { SUCCESSORS } from '../../presets/index.js'
import { FileReadings } from './readings.js'

export interface BaselineVerdict {
  missingFiles: string[]
  movedFiles: string[]
  modifiedFiles: string[]
}

export function baselineVerdict(root: string, manifest: Manifest, readings: FileReadings = new FileReadings(root)): BaselineVerdict {
  const missingFiles: string[] = []
  const movedFiles: string[] = []
  const modifiedFiles: string[] = []
  for (const [file, hash] of Object.entries(recordedShas(manifest))) {
    if (!existsSync(path.join(root, file))) {
      const successor = SUCCESSORS[file]
      if (successor != null && existsSync(path.join(root, successor)))
        movedFiles.push(file)
      else
        missingFiles.push(file)
      continue
    }
    const content = readings.read(file)
    if (content != null && sha256(content) !== hash)
      modifiedFiles.push(file)
  }
  return { missingFiles, movedFiles, modifiedFiles }
}
