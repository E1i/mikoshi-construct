import { spawnSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

export const LOOP_SCRIPT_NAME = 'loop'
export const TAB_WORD = '--tab'
export const WINDOW_SCRIPTS: ReadonlyArray<readonly [readonly string[], string]> = [
  [['watch'], 'watch'],
  [['handoff', 'write'], 'handoff-write'],
  [['handoff', 'check'], 'handoff-check'],
  [['request'], 'window-requests'],
  [['exit'], 'exit'],
]

export const FACTORY_START_WORD = 'start'
export const FACTORY_STARTER_FLAG = '--miko'

const FACTORY_STARTER = path.join('..', 'supervisor', 'start')
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

export function mikoHelp(): string {
  return [`miko ${TAB_WORD}  (a tab window, no loop)`, `miko ${FACTORY_START_WORD}  (starts the factory bus; its keep-alive only restarts what this started)`, ...WINDOW_SCRIPTS.map(([words, script]) => `miko ${words.join(' ')}  (${script})`)].join('\n')
}

export function mikoRoute(argv: readonly string[], here: string): MikoRoute {
  const dir = path.dirname(here)
  const extension = path.extname(here)
  const sibling = (name: string): string => path.join(dir, `${name}${extension}`)
  if (argv.length === 0 || argv[0] === TAB_WORD)
    return { script: sibling(LOOP_SCRIPT_NAME), args: [...argv] }
  if (argv[0] === FACTORY_START_WORD)
    return { script: path.join(dir, `${FACTORY_STARTER}${extension}`), args: [FACTORY_STARTER_FLAG, ...argv.slice(1)] }
  const window = WINDOW_SCRIPTS.find(([words]) => startsWith(argv, words))
  if (window !== undefined)
    return { script: sibling(window[1]), args: argv.slice(window[0].length) }
  return { script: path.join(dir, extension === SOURCE_EXTENSION ? PRODUCT_CLI_FROM_SOURCE : PRODUCT_CLI_BUILT), args: [...argv] }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const route = mikoRoute(process.argv.slice(2), fileURLToPath(import.meta.url))
  if (process.argv[2] === '--help')
    process.stdout.write(`${mikoHelp()}\n\n`)
  process.on('SIGINT', () => {})
  const run = spawnSync(process.execPath, [...process.execArgv, route.script, ...route.args], { stdio: 'inherit' })
  process.exitCode = run.status ?? 1
}
