import type { TestSpecification } from 'vitest/node'
import type { TestWeights } from './scripts/ci/shard.js'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { defineConfig } from 'vitest/config'
import { BaseSequencer } from 'vitest/node'
import { witnessGuard } from './scripts/ci/no-match-reporter.js'
import { balanceShards } from './scripts/ci/shard.js'
import { MACHINE_DIR_VARIABLE, setMachineLimit } from './scripts/core/machine-sessions.js'
import { LOCK_DIR_VARIABLE, sessionWorkers } from './scripts/quality/lock.js'

const SUITE_MACHINE_DIR = path.join(tmpdir(), 'construct-test-machine')
const SUITE_SESSION_LIMIT = 1000
const SUITE_LOAD_PER_CORE = 1000

const weights = JSON.parse(readFileSync(path.join(import.meta.dirname, 'scripts/ci/test-weights.json'), 'utf8')) as TestWeights

setMachineLimit(SUITE_MACHINE_DIR, SUITE_SESSION_LIMIT, SUITE_LOAD_PER_CORE)

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
    env: { NODE_OPTIONS: '--disable-warning=ExperimentalWarning', [MACHINE_DIR_VARIABLE]: SUITE_MACHINE_DIR, [LOCK_DIR_VARIABLE]: path.join(tmpdir(), 'construct-test-quality') },
    globalSetup: [path.join(import.meta.dirname, 'scripts/scratch/vitest-setup.ts')],
    setupFiles: [path.join(import.meta.dirname, 'scripts/scratch/vitest-bus.ts')],
    testTimeout: 30_000,
    maxWorkers: sessionWorkers(import.meta.dirname),
    sequence: { sequencer: WeightedShardSequencer },
  },
})
