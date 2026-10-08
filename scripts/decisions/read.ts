import { existsSync, readFileSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { decisionsRefusals, inForce, parseDecisions, PREFIX } from './decisions.js'

export const USAGE = 'usage: pnpm decisions [<owner-decisions.md>]'

export interface DecisionsReadDeps {
  home: string
  exists: (file: string) => boolean
  read: (file: string) => string
  out: (line: string) => void
  err: (line: string) => void
}

export function defaultDecisions(home: string): string {
  return path.join(home, '.construct', 'owner-decisions.md')
}

export function runDecisionsRead(args: string[], deps: DecisionsReadDeps): number {
  if (args.length > 1 || args[0]?.startsWith('--')) {
    deps.err(`${PREFIX}${USAGE}`)
    return 2
  }
  const file = args[0] ?? defaultDecisions(deps.home)
  if (!deps.exists(file)) {
    deps.err(`${PREFIX}no decisions at ${file}`)
    return 1
  }
  const text = deps.read(file)
  const refusals = decisionsRefusals(text)
  if (refusals.length > 0) {
    for (const line of refusals)
      deps.err(line)
    deps.err(`${PREFIX}${file} refused: ${refusals.length} refusals, no decision read`)
    return 1
  }
  for (const decision of inForce(parseDecisions(text).decisions))
    deps.out(decision.text)
  return 0
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runDecisionsRead(process.argv.slice(2), {
    home: os.homedir(),
    exists: existsSync,
    read: file => readFileSync(file, 'utf8'),
    out: line => console.log(line),
    err: line => console.error(line),
  })
}
