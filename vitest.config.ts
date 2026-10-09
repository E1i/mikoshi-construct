import type { TestSpecification } from 'vitest/node'
import type { TestWeights } from './scripts/ci/shard.js'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { defineConfig } from 'vitest/config'
import { BaseSequencer } from 'vitest/node'
import { witnessGuard } from './scripts/ci/no-match-reporter.js'
import { balanceShards } from './scripts/ci/shard.js'

const weights = JSON.parse(readFileSync(path.join(import.meta.dirname, 'scripts/ci/test-weights.json'), 'utf8')) as TestWeights

class WeightedShardSequencer extends BaseSequencer {
  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const { index, count } = this.ctx.config.shard!
    const byPath = new Map(files.map(file => [path.relative(this.ctx.config.root, file.moduleId), file]))
    return balanceShards([...byPath.keys()], weights, count)[index - 1]!.map(file => byPath.get(file)!)
  }
}

export default defineConfig({
  plugins: [witnessGuard()],
  test: {
    include: ['tests/**/*.test.ts', 'scripts/tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'tests/fixtures/**'],
    environment: 'node',
    testTimeout: 30_000,
    sequence: { sequencer: WeightedShardSequencer },
  },
})
