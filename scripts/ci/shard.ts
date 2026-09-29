export type TestWeights = Readonly<Record<string, number>>

export function weightOf(file: string, weights: TestWeights): number {
  const known = weights[file]
  if (known !== undefined)
    return known
  const values = Object.values(weights).sort((a, b) => a - b)
  return values.length === 0 ? 1 : values[Math.floor(values.length / 2)]!
}

export function balanceShards(files: readonly string[], weights: TestWeights, count: number): string[][] {
  const shards = Array.from({ length: count }, () => ({ files: [] as string[], total: 0 }))
  const heaviestFirst = [...files].sort((a, b) => weightOf(b, weights) - weightOf(a, weights) || (a < b ? -1 : a > b ? 1 : 0))
  for (const file of heaviestFirst) {
    const lightest = shards.reduce((best, shard) => (shard.total < best.total ? shard : best))
    lightest.files.push(file)
    lightest.total += weightOf(file, weights)
  }
  return shards.map(shard => shard.files)
}

export function weightsFromVitestReport(report: { testResults: { name: string, startTime: number, endTime: number }[] }, root: string): Record<string, number> {
  const prefix = root.endsWith('/') ? root : `${root}/`
  return Object.fromEntries(report.testResults
    .map(file => [file.name.startsWith(prefix) ? file.name.slice(prefix.length) : file.name, Math.round((file.endTime - file.startTime) / 100) / 10] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
}
