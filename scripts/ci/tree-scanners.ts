const WALKS_A_TREE = /\b(?:readdirSync|globSync)\b|['"`]ls-files['"`]/
const ROOT_JOINED_TO_A_TREE = /\b\w*(?:[Rr]oot|ROOT|dirname)\b[^)\n]*['"`](?:src|scripts)(?:\/[\w-]+)*['"`](?:,\s*['"`][\w-]+['"`])*\)/
const LIST_OF_ROOTS = /\b\w*ROOTS\s*=\s*\[[^\]\n]*['"`](?:src|scripts)(?:\/[\w-]+)*['"`]/
const ITERATED_TREE_NAMES = /\[[^\]\n]*['"`](?:src|scripts)['"`][^\]\n]*\]\.(?:flatMap|map|forEach|filter|some|every)\(/

export function namesATree(text: string): boolean {
  return ROOT_JOINED_TO_A_TREE.test(text) || LIST_OF_ROOTS.test(text) || ITERATED_TREE_NAMES.test(text)
}

export function walksATree(text: string): boolean {
  return WALKS_A_TREE.test(text)
}

export function scansATree(text: string): boolean {
  return walksATree(text) && namesATree(text)
}
