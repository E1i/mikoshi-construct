import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { withinTouches } from '../../src/card/covering-tests.js'
import { cardContract } from '../bus/card-contract.js'
import { BUSY_TIMEOUT_MS, defaultBusPath } from '../bus/db.js'
import { openDatabase } from '../bus/sqlite.js'

export const PREFIX = '[owner:command] '
export const USAGE = 'usage: pnpm owner:command --tree <worktree> --card <id> --message <commit message>'
export const PATCH_FILE = 'claude.patch'
export const COMMAND_FILE = 'command.txt'

export interface OwnerCommandPorts {
  git: (cwd: string, args: string[]) => string
  touches: (cardId: number) => string[] | null
  probesDir: string
  out: (line: string) => void
  err: (line: string) => void
}

export function probeDirOf(probesDir: string, cardId: number): string {
  return path.join(probesDir, `owner-${cardId}`)
}

function shellQuoted(word: string): string {
  return `'${word.replaceAll(`'`, `'\\''`)}'`
}

export function ownerCommand(patch: string, message: string): string {
  return `git apply --index ${shellQuoted(patch)} && git commit -q -m ${shellQuoted(message)}\n`
}

function untrackedOf(git: OwnerCommandPorts['git'], tree: string): string[] {
  return git(tree, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(file => file !== '')
}

interface OwnerArgs {
  tree: string
  cardId: number
  message: string
}

function ownerArgsOf(argv: string[]): OwnerArgs | null {
  try {
    const { values, positionals } = parseArgs({ args: argv, options: { tree: { type: 'string' }, card: { type: 'string' }, message: { type: 'string' } }, allowPositionals: true, strict: true })
    if (positionals.length > 0 || values.tree === undefined || values.message === undefined || values.message.trim() === '' || !/^[1-9]\d*$/.test(values.card ?? ''))
      return null
    return { tree: path.resolve(values.tree), cardId: Number(values.card), message: values.message }
  }
  catch {
    return null
  }
}

export function runOwnerCommand(argv: string[], ports: OwnerCommandPorts): number {
  const args = ownerArgsOf(argv)
  if (args === null) {
    ports.err(`${PREFIX}${USAGE}`)
    return 2
  }
  const touches = ports.touches(args.cardId)
  if (touches === null) {
    ports.err(`${PREFIX}card #${args.cardId}: the bus holds no card body that parses, so its touches are unknown; nothing written`)
    return 1
  }
  const untracked = untrackedOf(ports.git, args.tree)
  const outside = untracked.filter(file => !withinTouches(file, touches))
  if (outside.length > 0) {
    ports.err(`${PREFIX}card #${args.cardId}: ${args.tree} holds untracked files outside the card's touches; nothing written`)
    outside.forEach(file => ports.err(`${PREFIX}outside the touches: ${file}`))
    return 1
  }
  if (untracked.length > 0)
    ports.git(args.tree, ['add', '--intent-to-add', '--', ...untracked])
  const patch = ports.git(args.tree, ['diff', '--binary', 'HEAD'])
  if (patch.trim() === '') {
    ports.err(`${PREFIX}card #${args.cardId}: ${args.tree} holds no change against HEAD; nothing written`)
    return 1
  }
  const dir = probeDirOf(ports.probesDir, args.cardId)
  const patchPath = path.join(dir, PATCH_FILE)
  mkdirSync(dir, { recursive: true })
  writeFileSync(patchPath, patch)
  writeFileSync(path.join(dir, COMMAND_FILE), ownerCommand(patchPath, args.message))
  ports.out(`${PREFIX}card #${args.cardId}: ${patchPath} and ${path.join(dir, COMMAND_FILE)} written; ${untracked.length} new file(s) in the patch`)
  return 0
}

function busTouches(busPath: string): OwnerCommandPorts['touches'] {
  return (cardId) => {
    if (!existsSync(busPath))
      return null
    const db = openDatabase(busPath, { readOnly: true, timeout: BUSY_TIMEOUT_MS })
    try {
      return cardContract(db, cardId)?.touches ?? null
    }
    finally {
      db.close()
    }
  }
}

function realPorts(): OwnerCommandPorts {
  return {
    git: (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 }),
    touches: busTouches(defaultBusPath()),
    probesDir: path.join(os.homedir(), '.construct', 'probes'),
    out: line => process.stdout.write(`${line}\n`),
    err: line => process.stderr.write(`${line}\n`),
  }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = runOwnerCommand(process.argv.slice(2), realPorts())
