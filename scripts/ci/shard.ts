export type TestWeights = Readonly<Record<string, number>>

export const MIN_WEIGHT = 0.1
export const NO_DATA_WEIGHT = 1

const byPath = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

export function newTestWeight(weights: TestWeights): number {
  const values = Object.values(weights).map(value => Math.max(MIN_WEIGHT, value)).sort((a, b) => a - b)
  return values.length === 0 ? NO_DATA_WEIGHT : values[Math.floor(values.length / 2)]!
}

export function weightOf(file: string, weights: TestWeights): number {
  const known = weights[file]
  return known === undefined ? newTestWeight(weights) : Math.max(MIN_WEIGHT, known)
}

export function balanceShards(files: readonly string[], weights: TestWeights, count: number): string[][] {
  const unseen = newTestWeight(weights)
  const weigh = (file: string): number => weights[file] === undefined ? unseen : weightOf(file, weights)
  const shards = Array.from({ length: count }, () => ({ files: [] as string[], total: 0 }))
  const heaviestFirst = [...new Set(files)].map(file => ({ file, weight: weigh(file) })).sort((a, b) => b.weight - a.weight || byPath(a.file, b.file))
  for (const { file, weight } of heaviestFirst) {
    const lightest = shards.reduce((best, shard) => (shard.total < best.total ? shard : best))
    lightest.files.push(file)
    lightest.total += weight
  }
  return shards.map(shard => shard.files)
}

export function weightsFromFileWeights(record: unknown, exists: (file: string) => boolean): Record<string, number> {
  if (typeof record !== 'object' || record === null || Array.isArray(record))
    return {}
  return Object.fromEntries(Object.entries(record)
    .filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1]) && exists(entry[0]))
    .map(([file, seconds]) => [file, Math.max(MIN_WEIGHT, seconds)] as const)
    .sort(([a], [b]) => byPath(a, b)))
}

export function updateWeights(previous: TestWeights, measured: TestWeights, exists: (file: string) => boolean): Record<string, number> {
  const merged = { ...previous, ...measured }
  return Object.fromEntries(Object.keys(merged).filter(exists).sort(byPath).map(file => [file, Math.max(MIN_WEIGHT, merged[file]!)]))
}
