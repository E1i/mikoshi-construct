import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

export const LOOP_SCRIPT_NAME = 'loop'
export const WINDOW_SCRIPTS: ReadonlyArray<readonly [readonly string[], string]> = [
  [['watch'], 'watch'],
  [['handoff', 'write'], 'handoff-write'],
  [['handoff', 'check'], 'handoff-check'],
  [['request'], 'window-requests'],
  [['exit'], 'exit'],
]

const SOURCE_EXTENSION = '.ts'
const PRODUCT_CLI_FROM_SOURCE = path.join('..', '..', 'src', 'cli.ts')
const PRODUCT_CLI_BUILT = path.join('..', '..', 'cli.js')

export interface MikoRoute {
  script: string
  args: string[]
}

function startsWith(argv: readonly string[], words: readonly string[]): boolean {
  return words.every((word, index) => argv[index] === word)
}

export function mikoRoute(argv: readonly string[], here: string): MikoRoute {
  const dir = path.dirname(here)
  const extension = path.extname(here)
  const sibling = (name: string): string => path.join(dir, `${name}${extension}`)
  if (argv.length === 0)
    return { script: sibling(LOOP_SCRIPT_NAME), args: [] }
  const window = WINDOW_SCRIPTS.find(([words]) => startsWith(argv, words))
  if (window !== undefined)
    return { script: sibling(window[1]), args: argv.slice(window[0].length) }
  return { script: path.join(dir, extension === SOURCE_EXTENSION ? PRODUCT_CLI_FROM_SOURCE : PRODUCT_CLI_BUILT), args: [...argv] }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const route = mikoRoute(process.argv.slice(2), fileURLToPath(import.meta.url))
  process.on('SIGINT', () => {})
  const run = spawnSync(process.execPath, [...process.execArgv, route.script, ...route.args], { stdio: 'inherit' })
  process.exitCode = run.status ?? 1
}
