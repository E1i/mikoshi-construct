import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SOURCE_MODULE = /\.ts$/
const BUILT_MODULE = '.js'
const SOURCE_LOADER: readonly string[] = Object.freeze(['--import', 'tsx'])
const TYPE_ONLY_IMPORT = /^[ \t]*(?:import|export)[ \t]+type[ \t]+(?:\{[^}]*\}|\*[ \t]+as[ \t]+\w+|\w+)\s+from\s*'[^']+'/gm

export const CHECKOUT_BUILD_DIR = 'dist'
export const BUILT_FROM_FILE = 'built-from'

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

export function runtimeSourceOf(root: string): (file: string) => string | null {
  return (file) => {
    try {
      return readFileSync(path.join(root, file), 'utf8').replace(TYPE_ONLY_IMPORT, '')
    }
    catch {
      return null
    }
  }
}

export function builtFromFile(root: string): string {
  return path.join(root, CHECKOUT_BUILD_DIR, BUILT_FROM_FILE)
}

export function builtFrom(root: string): string | null {
  const file = builtFromFile(root)
  if (!existsSync(file))
    return null
  const head = readFileSync(file, 'utf8').trim()
  return head === '' ? null : head
}

export function buildOf(root: string, head: string | undefined): string | null {
  return head !== undefined && head !== '' && builtFrom(root) === head ? root : null
}

export type BuildRun = (root: string) => { ok: boolean, output: string }

export class CheckoutBuild {
  private failedOn: string | null = null

  constructor(private readonly root: string, private readonly run: BuildRun, private readonly prefix: string) {}

  ensure(head: string | undefined): string[] {
    if (head === undefined || head === '' || buildOf(this.root, head) !== null || this.failedOn === head)
      return []
    const built = this.run(this.root)
    if (!built.ok) {
      this.failedOn = head
      return [`${this.prefix}the factory build of ${head} failed, so bus processes start from their sources through tsx until the next head: ${built.output.trim().split('\n').at(-1) ?? ''}`]
    }
    writeFileSync(builtFromFile(this.root), `${head}\n`)
    return [`${this.prefix}built the factory once for ${head}; bus processes start from ${CHECKOUT_BUILD_DIR}, not through tsx`]
  }
}
