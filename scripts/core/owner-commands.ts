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
