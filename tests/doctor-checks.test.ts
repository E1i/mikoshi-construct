import type { HarnessFacts } from '../src/commands/doctor/harness.js'
import type { Manifest } from '../src/manifest.js'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { includeGlobs } from '../src/commands/doctor/runner.js'
import { typecheckWarnings } from '../src/commands/doctor/typecheck.js'
import { uncollectedTests } from '../src/commands/doctor/uncollected-tests.js'
import { matchesAnyGlob } from '../src/model/glob.js'

const COMMAND = 'pnpm run quality'

function harnessFacts(overrides: Partial<HarnessFacts> = {}): HarnessFacts {
  return {
    command: COMMAND,
    script: 'quality',
    body: 'pnpm lint && pnpm test',
    resolved: 'pnpm lint && pnpm test && vitest run',
    packageJson: {},
    ...overrides,
  }
}

function scratch(): string {
  return mkdtempSync(path.join(tmpdir(), 'construct-doctor-'))
}

function write(root: string, file: string, content: string): void {
  mkdirSync(path.join(root, path.dirname(file)), { recursive: true })
  writeFileSync(path.join(root, file), content)
}

function manifestRecording(files: string[]): Manifest {
  return { files: Object.fromEntries(files.map(file => [file, 'sha'])) } as unknown as Manifest
}

describe('the recorded tests the runner config does not collect', () => {
  it('names a recorded test outside the include globs of the runner config the construct wrote', () => {
    const root = scratch()
    write(root, 'vitest.config.ts', 'export default { test: { include: [\'src/**/*.test.ts\'] } }')
    expect(uncollectedTests(root, manifestRecording(['vitest.config.ts', 'tests/harness.test.ts']))).toEqual(['tests/harness.test.ts'])
  })

  it('says nothing where the runner config is not in the record, because the construct never wrote that end', () => {
    const root = scratch()
    write(root, 'vitest.config.ts', 'export default { test: { include: [\'src/**/*.test.ts\'] } }')
    expect(uncollectedTests(root, manifestRecording(['tests/harness.test.ts']))).toEqual([])
  })

  it('says nothing rather than guessing when the include cannot be read literally', () => {
    const root = scratch()
    write(root, 'vitest.config.ts', 'export default { test: { include: TEST_GLOBS } }')
    expect(uncollectedTests(root, manifestRecording(['vitest.config.ts', 'tests/harness.test.ts']))).toEqual([])
  })

  it('says nothing rather than guessing when the recorded runner config cannot be read at all', () => {
    expect(uncollectedTests(scratch(), manifestRecording(['vitest.config.ts', 'tests/harness.test.ts']))).toEqual([])
  })
})

describe('reading the runner include without executing the config', () => {
  it('collects every literal include list, including nested projects', () => {
    const source = 'export default defineConfig({ test: { projects: [{ test: { include: [\'tests/**/*.test.ts\'] } }, { test: { include: [\'scripts/tests/**/*.test.ts\'] } }] } })'
    expect(includeGlobs(source)).toEqual(['tests/**/*.test.ts', 'scripts/tests/**/*.test.ts'])
  })

  it('returns unknown rather than absent for a non-literal include', () => {
    expect(includeGlobs('export default { test: { include: TEST_GLOBS } }')).toBeNull()
    // eslint-disable-next-line no-template-curly-in-string
    expect(includeGlobs('export default { test: { include: [`tests/${suffix}.test.ts`] } }')).toBeNull()
    expect(includeGlobs('export default { test: { include: [...defaults, \'tests/**/*.test.ts\'] } }')).toBeNull()
    expect(includeGlobs('export default { test: { include: globs() } }')).toBeNull()
    expect(includeGlobs('export default { test: { environment: \'node\' } }')).toBeNull()
  })

  it('matches a file against a literal glob without a dependency', () => {
    expect(matchesAnyGlob('tests/http/error-handler.test.ts', ['tests/**/*.test.ts'])).toBe(true)
    expect(matchesAnyGlob('tests/health.test.ts', ['tests/**/*.test.ts'])).toBe(true)
    expect(matchesAnyGlob('src/health.test.ts', ['tests/**/*.test.ts'])).toBe(false)
    expect(matchesAnyGlob('apps/api/tests/health.test.ts', ['apps/*/tests/**/*.test.ts'])).toBe(true)
    expect(matchesAnyGlob('tests/health.test.tsx', ['tests/**/*.test.{ts,tsx}'])).toBe(true)
  })
})

describe('the per-preset typecheck caveat', () => {
  it('warns only for the presets where a bare tsc cannot carry the stack', () => {
    expect(typecheckWarnings('node-backend', harnessFacts())).toEqual([])
    expect(typecheckWarnings('node-frontend', harnessFacts())[0]).toContain('vue-tsc')
  })

  it('stays quiet once the harness already runs the framework checker', () => {
    expect(typecheckWarnings('node-frontend', harnessFacts({ resolved: 'vue-tsc --noEmit && vitest run' }))).toEqual([])
  })
})
