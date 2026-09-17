import type { Manifest } from '../../manifest.js'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { sha256 } from '../../manifest.js'

export interface BaselineVerdict {
  missingFiles: string[]
  modifiedFiles: string[]
}

export function baselineVerdict(root: string, manifest: Manifest): BaselineVerdict {
  const missingFiles: string[] = []
  const modifiedFiles: string[] = []
  for (const [file, hash] of Object.entries(manifest.files)) {
    const absolute = path.join(root, file)
    if (!existsSync(absolute))
      missingFiles.push(file)
    else if (sha256(readFileSync(absolute, 'utf8')) !== hash)
      modifiedFiles.push(file)
  }
  return { missingFiles, modifiedFiles }
}
