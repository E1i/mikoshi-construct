import type { ParkedDepends } from '../ghosts/handoff-check.js'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { defaultParking, handoffRefusals, parkedDepends } from '../ghosts/handoff-check.js'

export const PREFIX = '[miko:handoff] '
const MIKOSHI_HANDOFF = '~/.construct/handoff/mikoshi.md'
const MIKOSHI_PROMPT = `Прочитай ${MIKOSHI_HANDOFF} и продолжай как Mikoshi`
const MIKOSHI_SESSION = `cd ~/projects/mikoshi-construct && GH_TOKEN=$(gh auth token --user E1i) caffeinate -dis claude --permission-mode auto \\"${MIKOSHI_PROMPT}\\"`
const NEW_TERMINAL_RUNNING_MIKOSHI = `tell app "Terminal" to do script "${MIKOSHI_SESSION}"`

export interface MikoHandoffDeps {
  home: string
  exists: (file: string) => boolean
  read: (file: string) => string
  parked: (parking: string) => ParkedDepends
  openTerminal: (script: string) => void
  err: (line: string) => void
}

export function mikoshiHandoff(home: string): string {
  return path.join(home, MIKOSHI_HANDOFF.slice(2))
}

export function runMikoHandoff(deps: MikoHandoffDeps): number {
  const file = mikoshiHandoff(deps.home)
  if (!deps.exists(file)) {
    deps.err(`${PREFIX}no handoff at ${file}; write it with pnpm handoff:write ${file} <draft>`)
    return 1
  }
  const refusals = handoffRefusals(deps.read(file), { file, home: deps.home, exists: deps.exists, parked: deps.parked(defaultParking(deps.home)) })
  if (refusals.length > 0) {
    for (const line of refusals)
      deps.err(line)
    deps.err(`${PREFIX}${file} is not a handoff: no Terminal opened; rewrite it with pnpm handoff:write ${file} <draft>`)
    return 1
  }
  deps.openTerminal(NEW_TERMINAL_RUNNING_MIKOSHI)
  return 0
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runMikoHandoff({
    home: os.homedir(),
    exists: existsSync,
    read: file => readFileSync(file, 'utf8'),
    parked: parkedDepends,
    openTerminal: script => execFileSync('osascript', ['-e', script], { stdio: 'inherit' }),
    err: line => console.error(line),
  })
}
