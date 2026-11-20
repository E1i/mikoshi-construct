import path from 'node:path'

export interface CardGrant {
  card: number
  decision: string
  allow: readonly string[]
  domains: readonly string[]
  homeWrites: readonly string[]
}

export const CARD_GRANTS: readonly CardGrant[] = [
  {
    card: 2156,
    decision: 'D-705',
    allow: ['Bash(codex *)', 'Bash(git init $TMPDIR/*)', 'Bash(mkdir $TMPDIR/*)', 'Bash(mkdir -p $TMPDIR/*)'],
    domains: ['api.openai.com', 'chatgpt.com', 'auth.openai.com'],
    homeWrites: ['.codex'],
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
