export type OwnerCommandArgument = string | number

function commandLine(program: string, head: string, args: readonly OwnerCommandArgument[]): string {
  return [program, head, ...args.map(String)].join(' ')
}

export function pnpmCommand(script: string, ...args: readonly OwnerCommandArgument[]): string {
  return commandLine('pnpm', script, args)
}

export const ADMIT_COMMAND = pnpmCommand('intake', '--admit')

export function constructCommand(command: string, ...args: readonly OwnerCommandArgument[]): string {
  return commandLine('construct', command, args)
}

export function npxConstructCommand(command: string, ...args: readonly OwnerCommandArgument[]): string {
  return commandLine('npx', 'mikoshi-construct', [command, ...args])
}

export const QUALITY_COMMAND = pnpmCommand('run', 'quality')

export const INTAKE_COMMAND = pnpmCommand('intake')

export const HANDOFF_WRITE_COMMAND = pnpmCommand('handoff:write')

export const MIKO_COMMAND = pnpmCommand('miko')

export const MIKO_WATCH_COMMAND = pnpmCommand('miko:watch')

export const MIKO_EXIT_COMMAND = pnpmCommand('miko:exit')

export const OWNER_SAY_COMMAND = pnpmCommand('owner:say')

export const OWNER_COMMAND_COMMAND = pnpmCommand('owner:command')

export const TSX_COMMAND = pnpmCommand('exec', 'tsx')

export const PNPM_FORM_LABEL = 'pnpm form'

export const OWNER_MOVES = ['stop', 'launch', 'takeover', 'requeue'] as const

export type OwnerMove = typeof OWNER_MOVES[number]

export const OWNER_MOVE_REQUESTS = ['owner.stop', 'owner.launch', 'owner.takeover', 'owner.requeue'] as const satisfies readonly `owner.${OwnerMove}`[]

export type OwnerMoveRequest = typeof OWNER_MOVE_REQUESTS[number]

const REQUEST_SCRIPT = 'bus:request'
const CARD_FLAG = '--card'
const TASK_FLAG = '--task'

export const BUS_REQUEST_COMMAND = pnpmCommand(REQUEST_SCRIPT)

export function isOwnerMoveRequest(kind: unknown): kind is OwnerMoveRequest {
  return typeof kind === 'string' && (OWNER_MOVE_REQUESTS as readonly string[]).includes(kind)
}

export function ownerMoveOf(request: OwnerMoveRequest): OwnerMove {
  return OWNER_MOVES[OWNER_MOVE_REQUESTS.indexOf(request)]!
}

export function ownerMoveFlag(move: OwnerMove): string {
  return move === 'requeue' ? TASK_FLAG : CARD_FLAG
}

export function ownerMoveCommand(move: OwnerMove, target: OwnerCommandArgument): string {
  return pnpmCommand(REQUEST_SCRIPT, OWNER_MOVE_REQUESTS[OWNER_MOVES.indexOf(move)]!, ownerMoveFlag(move), target)
}

export function ownerMoveUsage(): string {
  return OWNER_MOVES.map(move => `${OWNER_MOVE_REQUESTS[OWNER_MOVES.indexOf(move)]!} ${ownerMoveFlag(move)} <${move === 'requeue' ? 'task_key' : 'N'}>`).join(' | ')
}

export function ownerMoveRequestOf(request: OwnerMoveRequest, argv: readonly string[]): Record<string, unknown> | null {
  const flag = ownerMoveFlag(ownerMoveOf(request))
  const at = argv.indexOf(flag)
  const target = at === -1 ? undefined : argv[at + 1]
  if (target === undefined || target.startsWith('--'))
    return null
  if (flag === TASK_FLAG)
    return { kind: request, task_key: target }
  const card = Number(target.replace(/^#/, ''))
  return Number.isInteger(card) && card > 0 ? { kind: request, card } : null
}
