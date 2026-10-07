import { realpathSync } from 'node:fs'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { cloudOn } from './cloud-key.js'

export const ROLES = ['brief', 'scan', 'review'] as const

export type Role = (typeof ROLES)[number]

export interface RoleOutcome {
  code: number
  out: string[]
  err: string[]
}

const USAGE = `usage: role.ts <${ROLES.join('|')}> --task <id>`

function isRole(value: string | undefined): value is Role {
  return (ROLES as readonly (string | undefined)[]).includes(value)
}

function cloudLine(role: Role, task: string): string {
  return `cloud: ${role} for ${task} runs as a cloud session; it pushes role/${task}-${role} with role/${task}/${role}.md (and, for review, role/${task}/review.verdict.json); accept with pnpm ghosts:verdict --from <ref> ...`
}

export function roleOutcome(argv: string[], env: Record<string, string | undefined>): RoleOutcome {
  const { positionals, values } = parseArgs({ args: argv, allowPositionals: true, options: { task: { type: 'string' } } })
  const role = positionals[0]
  const task = values.task
  if (!isRole(role) || positionals.length !== 1 || task === undefined || task === '')
    return { code: 1, out: [], err: [USAGE] }
  return { code: 0, out: [cloudOn(env) ? cloudLine(role, task) : `local: launch the ${role} agent for ${task}`], err: [] }
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outcome = roleOutcome(process.argv.slice(2), process.env)
  for (const line of outcome.out)
    console.log(line)
  for (const line of outcome.err)
    console.error(line)
  process.exitCode = outcome.code
}
