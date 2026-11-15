import { readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { installedPackage } from './bg.js'

interface Generation {
  head: () => string
}

export function packageGeneration(root: string): Generation {
  return {
    head: () => {
      const version = (JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { version?: unknown }).version
      if (typeof version !== 'string' || version === '')
        throw new Error(`the package.json of ${root} names no version`)
      return version
    },
  }
}

export function installedGeneration(installed: string | null = installedPackage()): Generation | null {
  return installed === null ? null : packageGeneration(installed)
}

export const ownPackage = (): string => installedPackage() ?? process.cwd()
