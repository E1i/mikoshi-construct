import path from 'node:path'

const RELATIVE_IMPORT = /\b(?:import|export)\s[^'"]*?\sfrom\s*'(\.{1,2}\/[^']+)'|\bimport\s*'(\.{1,2}\/[^']+)'/g

export function importClosure(entry: string, readFile: (file: string) => string | null): Set<string> {
  const texts = new Map<string, string | null>()
  const read = (file: string): string | null => {
    if (!texts.has(file))
      texts.set(file, readFile(file))
    return texts.get(file) ?? null
  }
  const sourceOf = (target: string): string => target.endsWith('.js') && read(`${target.slice(0, -3)}.ts`) !== null ? `${target.slice(0, -3)}.ts` : target
  const seen = new Set<string>()
  const next = [entry]
  for (let file = next.pop(); file !== undefined; file = next.pop()) {
    if (seen.has(file))
      continue
    const text = read(file)
    if (text === null)
      continue
    seen.add(file)
    for (const match of text.matchAll(RELATIVE_IMPORT))
      next.push(sourceOf(path.posix.join(path.posix.dirname(file), match[1] ?? match[2]!)))
  }
  return seen
}
