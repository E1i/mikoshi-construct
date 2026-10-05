export { unresolvedCommandWord } from '../intake/command-word.js'

const FILE_EDITING = [/\S+:fix(?=\s|$)/, /--fix(?=[\s=]|$)/, /--write(?=[\s=]|$)/]

const PACKAGE_RUNNERS = ['npm run', 'npx']

export function throughPackageRunners(command: string, word: string): string[] {
  const trimmed = command.trim()
  const at = trimmed.split(/(\s+)/).findIndex(token => token === word)
  return PACKAGE_RUNNERS.map(runner => trimmed.split(/(\s+)/).map((token, index) => index === at ? `${runner} ${token}` : token).join(''))
}

export function fileEditingMarks(command: string): string[] {
  return FILE_EDITING.flatMap(pattern => command.match(pattern)?.[0] ?? [])
}
