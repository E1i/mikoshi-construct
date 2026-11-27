import type { TaskStartDeps, TaskStartFlags, TaskStartResult } from '../ports/task-start.js'
import { existsSync, realpathSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { terminalStyle } from '../../src/ui/signal.js'
import { BUS_CONTRACT } from '../core/bus-adapter.js'
import { busAdmittedBodies } from '../core/card-bodies.js'
import { defaultBusPath } from '../core/db.js'
import { pnpmCommand } from '../core/owner-commands.js'
import { clientAdapter, windowModeOf } from '../ports/session.js'
import { flagValue, gitIn, refuse, runTaskStart, WINDOW_LIMIT_SLOTS } from '../ports/task-start.js'
import { cardTree } from '../ports/worktree-home.js'
import { pnpmInstall } from '../ports/worktree.js'
import { slotsOf } from '../supervisor/scheduler.js'

export const TASK_START_FLAGS: TaskStartFlags = { card: '--card', adopt: '--adopt', withoutIntake: '--without-intake' }

const CARD_ID = /^#(\d+)\s/

export function realDeps(): TaskStartDeps {
  return {
    contract: BUS_CONTRACT,
    flags: TASK_START_FLAGS,
    cwd: process.cwd(),
    git: gitIn,
    install: pnpmInstall,
    exists: existsSync,
    bus: defaultBusPath(),
    now: () => new Date(),
    session: clientAdapter().ownSession(process.env) ?? undefined,
    treeOf: id => cardTree(process.env, defaultBusPath(), id),
    cardBody: busAdmittedBodies(BUS_CONTRACT, defaultBusPath()),
    style: terminalStyle(process.stdout.isTTY, process.env.NO_COLOR),
    windowLimit: () => slotsOf(WINDOW_LIMIT_SLOTS, process.env),
  }
}

function cardIdOf(argv: string[]): string {
  return CARD_ID.exec(flagValue(argv, TASK_START_FLAGS.card).value ?? '')?.[1] ?? '<N>'
}

function refusedInWindow(argv: string[]): TaskStartResult {
  return refuse(`a window does not start a task itself: the bus cuts its tree, ask it with ${pnpmCommand('bus:request', 'tree.cut', TASK_START_FLAGS.card, cardIdOf(argv))}; nothing written`)
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2)
  const result = windowModeOf(process.env) === null ? runTaskStart(argv, realDeps()) : refusedInWindow(argv)
  for (const line of result.stdout)
    console.log(line)
  for (const line of result.stderr)
    console.error(line)
  if (result.exitCode === 0)
    process.exitCode = 0
  else
    process.exitCode = 1
}
