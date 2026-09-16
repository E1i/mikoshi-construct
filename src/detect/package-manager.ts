import type { PackageManager } from './report.js'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const LOCKFILES: Array<[string, PackageManager]> = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['bun.lockb', 'bun'],
  ['bun.lock', 'bun'],
  ['yarn.lock', 'yarn'],
  ['package-lock.json', 'npm'],
]

function fromPackageManagerField(dir: string): PackageManager | null {
  const manifest = path.join(dir, 'package.json')
  if (!existsSync(manifest))
    return null
  try {
    const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { packageManager?: string }
    const name = parsed.packageManager?.split('@')[0]
    return name === 'pnpm' || name === 'npm' || name === 'yarn' || name === 'bun' ? name : null
  }
  catch {
    return null
  }
}

export function detectPackageManager(dir: string): PackageManager {
  const declared = fromPackageManagerField(dir)
  if (declared != null)
    return declared
  for (const [lockfile, manager] of LOCKFILES) {
    if (existsSync(path.join(dir, lockfile)))
      return manager
  }
  return existsSync(path.join(dir, 'package.json')) ? 'npm' : 'none'
}
