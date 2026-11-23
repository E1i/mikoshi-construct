import os from 'node:os'
import path from 'node:path'

export interface CardGrant {
  card: number
  decision: string
  allow: readonly string[]
  domains: readonly string[]
  homeWrites: readonly string[]
  excludedCommands: readonly string[]
}

const SANDBOX_UID = os.userInfo().uid

export const GRANT_SCRATCH_DIRECTORY = `/tmp/claude-${SANDBOX_UID}/codex-live-hooks`

export const GRANT_SCRATCH_SPELLINGS = [GRANT_SCRATCH_DIRECTORY, `/private${GRANT_SCRATCH_DIRECTORY}`] as const

const scratchFileRules = GRANT_SCRATCH_SPELLINGS.flatMap(scratch => [`Write(/${scratch}/**)`, `Edit(/${scratch}/**)`])

export const CARD_GRANTS: readonly CardGrant[] = [
  {
    card: 2156,
    decision: 'D-705',
    allow: ['Bash(codex *)', `Bash(mkdir -p ${GRANT_SCRATCH_DIRECTORY})`, `Bash(mkdir ${GRANT_SCRATCH_DIRECTORY})`, `Bash(git init ${GRANT_SCRATCH_DIRECTORY})`, ...scratchFileRules],
    domains: ['api.openai.com', 'chatgpt.com', 'auth.openai.com'],
    homeWrites: ['.codex'],
    excludedCommands: ['codex exec *'],
  },
]

const CARD_TREE_NAME = /^(?:mc-)?(\d+)$/

export function cardOfTree(tree: string): number | null {
  const id = CARD_TREE_NAME.exec(path.basename(tree))?.[1]
  return id === undefined ? null : Number(id)
}

export function grantOf(card: number | null, grants: readonly CardGrant[] = CARD_GRANTS): CardGrant | null {
  return card === null ? null : grants.find(grant => grant.card === card) ?? null
}
