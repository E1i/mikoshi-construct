import { fileURLToPath } from 'node:url'

const SOURCE_MODULE = /\.ts$/
const BUILT_MODULE = '.js'
const SOURCE_LOADER: readonly string[] = Object.freeze(['--import', 'tsx'])

export interface BuiltEntry {
  url: URL
  file: string
  loader: readonly string[]
}

export function runsFromTheBuild(module: string): boolean {
  return !SOURCE_MODULE.test(new URL(module).pathname)
}

export function builtEntry(source: URL, module: string): BuiltEntry {
  if (!SOURCE_MODULE.test(source.pathname))
    throw new Error(`${source.href} names no .ts source, so it has no built twin to resolve`)
  const fromTheBuild = runsFromTheBuild(module)
  const url = fromTheBuild ? new URL(source.pathname.replace(SOURCE_MODULE, BUILT_MODULE), source) : source
  return { url, file: fileURLToPath(url), loader: fromTheBuild ? [] : SOURCE_LOADER }
}
