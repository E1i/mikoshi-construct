import { existsSync, realpathSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const STAMP_SCRIPT = fileURLToPath(import.meta.url)
const TSX_LOADER = path.resolve(import.meta.dirname, '..', '..', 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs')

export interface Stamper {
  command: string
  args: string[]
  ready: () => boolean
}

export const TSX_STAMPER: Stamper = {
  command: process.execPath,
  args: ['--import', pathToFileURL(TSX_LOADER).href, STAMP_SCRIPT],
  ready: () => existsSync(TSX_LOADER) && existsSync(STAMP_SCRIPT),
}

export function stampEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env, TSX_DISABLE_CACHE: '1' }
}

export class LineStamper {
  private carry = ''

  constructor(private readonly now: () => Date = () => new Date()) {}

  push(chunk: string): string {
    const lines = `${this.carry}${chunk}`.split('\n')
    this.carry = lines.pop()!
    return lines.map(line => this.stamp(line)).join('')
  }

  end(): string {
    const rest = this.carry
    this.carry = ''
    return rest === '' ? '' : this.stamp(rest)
  }

  private stamp(line: string): string {
    return `${this.now().toISOString()} ${line}\n`
  }
}

function stampStdin(): void {
  const stamper = new LineStamper()
  for (const signal of ['SIGHUP', 'SIGINT'] as const)
    process.on(signal, () => {})
  process.stdout.on('error', () => {})
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk: string) => process.stdout.write(stamper.push(chunk)))
  process.stdin.on('end', () => process.stdout.write(stamper.end()))
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === STAMP_SCRIPT)
  stampStdin()
