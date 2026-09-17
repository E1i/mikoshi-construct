import type { DoctorEvidence } from '../src/commands/doctor/evidence.js'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ciCheck } from '../src/commands/doctor/checks/ci.js'
import { constructTestsCheck } from '../src/commands/doctor/checks/construct-tests.js'
import { hookCheck } from '../src/commands/doctor/checks/hook.js'
import { lintPolicyCheck } from '../src/commands/doctor/checks/lint-policy.js'
import { redGateCheck } from '../src/commands/doctor/checks/red-gate.js'
import { harnessReach } from '../src/commands/doctor/enforcement.js'
import { readHookFacts } from '../src/commands/doctor/hooks.js'
import { includeGlobs, matchesAnyGlob, readRunnerFacts } from '../src/commands/doctor/runner.js'
import { typecheckWarnings } from '../src/commands/doctor/typecheck.js'
import { weakestLink } from '../src/commands/doctor/verdict.js'
import { readWorkflowFacts } from '../src/commands/doctor/workflows.js'

const COMMAND = 'pnpm run quality'
const COMMAND_FORMS = [COMMAND, 'pnpm run quality', 'pnpm quality', 'npm run quality', 'yarn quality']

function evidence(overrides: Partial<DoctorEvidence> = {}): DoctorEvidence {
  return {
    harness: {
      command: COMMAND,
      script: 'quality',
      scripts: { quality: 'pnpm lint && pnpm test', test: 'vitest run' },
      body: 'pnpm lint && pnpm test',
      resolved: 'pnpm lint && pnpm test && vitest run',
      commandForms: COMMAND_FORMS,
      packageJson: {},
    },
    runner: {
      file: 'vitest.config.ts',
      globs: ['tests/**/*.test.ts', 'scripts/tests/**/*.test.ts'],
      note: 'vitest.config.ts includes "tests/**/*.test.ts", "scripts/tests/**/*.test.ts"',
      invokedByHarness: true,
    },
    workflows: { directory: '.github/workflows', files: ['ci.yml'], harnessWorkflow: '.github/workflows/ci.yml', unreadable: [] },
    hooks: { manager: null, script: null, runsHarness: false },
    recordedTests: ['tests/health.test.ts', 'scripts/tests/lint/syntax-policy.test.ts'],
    policyTests: ['scripts/tests/lint/syntax-policy.test.ts'],
    unreadable: [],
    ...overrides,
  }
}

function scratch(): string {
  return mkdtempSync(path.join(tmpdir(), 'construct-hooks-'))
}

function write(root: string, file: string, content: string): void {
  mkdirSync(path.join(root, path.dirname(file)), { recursive: true })
  writeFileSync(path.join(root, file), content)
}

describe('the enforcement level a harness command can reach', () => {
  it('is L3 when a workflow runs it, L2 when only a hook does, L0 when neither does', () => {
    expect(harnessReach(evidence()).level).toBe('L3')
    expect(harnessReach(evidence({
      workflows: { directory: '.github/workflows', files: [], harnessWorkflow: null, unreadable: [] },
      hooks: { manager: 'lefthook.yml', script: null, runsHarness: true },
    })).level).toBe('L2')
    expect(harnessReach(evidence({
      workflows: { directory: '.github/workflows', files: [], harnessWorkflow: null, unreadable: [] },
    })).level).toBe('L0')
  })
})

describe('the lint-policy check', () => {
  it('is present at the harness level when a recorded test resolves the policy and the runner collects it', () => {
    const verdict = lintPolicyCheck(evidence())
    expect(verdict).toMatchObject({ id: 'lint-policy', state: 'present', level: 'L3' })
    expect(verdict.evidence).toContain('scripts/tests/lint/syntax-policy.test.ts')
  })

  it('is absent at L0 when no recorded file resolves the policy', () => {
    expect(lintPolicyCheck(evidence({ policyTests: [] }))).toMatchObject({ id: 'lint-policy', state: 'absent', level: 'L0' })
  })

  it('is absent at L0 and names the weakest link when the runner never collects the policy check', () => {
    const verdict = lintPolicyCheck(evidence({ runner: { file: 'vitest.config.ts', globs: ['src/**/*.test.ts'], note: 'vitest.config.ts includes "src/**/*.test.ts"', invokedByHarness: true } }))
    expect(verdict).toMatchObject({ state: 'absent', level: 'L0' })
    expect(verdict.evidence).toContain('weakest link')
  })

  it('is absent at L0 when the harness command does not run the runner', () => {
    expect(lintPolicyCheck(evidence({ runner: { file: 'vitest.config.ts', globs: ['scripts/tests/**/*.test.ts'], note: 'note', invokedByHarness: false } }))).toMatchObject({ state: 'absent', level: 'L0' })
  })

  it('is unknown, never absent, when only the runner config cannot be read literally', () => {
    expect(lintPolicyCheck(evidence({ runner: { file: 'vitest.config.ts', globs: null, note: 'the include in vitest.config.ts is not a literal list of strings', invokedByHarness: true } }))).toMatchObject({ state: 'unknown', level: 'L3' })
  })
})

describe('the construct-tests check', () => {
  it('is present when every recorded test matches an include glob', () => {
    expect(constructTestsCheck(evidence())).toMatchObject({ id: 'construct-tests', state: 'present', level: 'L3' })
  })

  it('is absent at L0 when a recorded test falls outside the include globs', () => {
    const verdict = constructTestsCheck(evidence({ runner: { file: 'vitest.config.ts', globs: ['src/**/*.test.ts'], note: 'note', invokedByHarness: true } }))
    expect(verdict).toMatchObject({ state: 'absent', level: 'L0' })
    expect(verdict.evidence).toContain('tests/health.test.ts')
  })

  it('is unknown when the include is missing, non-literal or in an unreadable config', () => {
    for (const note of ['no runner config file exists', 'the include is not a literal list of strings', 'vitest.config.ts cannot be read']) {
      expect(constructTestsCheck(evidence({ runner: { file: null, globs: null, note, invokedByHarness: true } }))).toMatchObject({ state: 'unknown' })
    }
  })
})

describe('the ci check', () => {
  it('is present at L3 when a workflow step runs the harness command, and says the scope is not in the repository', () => {
    const verdict = ciCheck(evidence())
    expect(verdict).toMatchObject({ id: 'ci', state: 'present', level: 'L3' })
    expect(verdict.evidence).toContain('branch protection')
  })

  it('is unknown, never absent, when no workflow runs the harness command', () => {
    expect(ciCheck(evidence({ workflows: { directory: '.github/workflows', files: ['ci.yml'], harnessWorkflow: null, unreadable: [] } }))).toMatchObject({ state: 'unknown', level: 'L0' })
    expect(ciCheck(evidence({ workflows: { directory: '.github/workflows', files: [], harnessWorkflow: null, unreadable: [] } }))).toMatchObject({ state: 'unknown', level: 'L0' })
  })
})

describe('the hook check', () => {
  it('is present at L2 for a hook manager and present at L0 for a bare script', () => {
    expect(hookCheck(evidence({ hooks: { manager: 'lefthook.yml', script: null, runsHarness: true } }))).toMatchObject({ id: 'hook', state: 'present', level: 'L2' })
    expect(hookCheck(evidence({ hooks: { manager: null, script: 'precommit', runsHarness: false } }))).toMatchObject({ state: 'present', level: 'L0' })
    expect(hookCheck(evidence())).toMatchObject({ state: 'absent', level: 'L0' })
  })

  it('reads every hook manager this repository can carry', () => {
    const cases: Array<[string, (root: string) => void]> = [
      ['.husky/pre-commit', root => write(root, '.husky/pre-commit', 'pnpm run quality\n')],
      ['lefthook.yml', root => write(root, 'lefthook.yml', 'pre-commit:\n  commands:\n    quality:\n      run: pnpm run quality\n')],
      ['package.json (simple-git-hooks)', () => {}],
      ['.git/config (core.hooksPath)', root => write(root, '.git/config', '[core]\n\thooksPath = .githooks\n')],
    ]
    for (const [expected, prepare] of cases) {
      const root = scratch()
      prepare(root)
      const packageJson = expected.startsWith('package.json') ? { 'simple-git-hooks': { 'pre-commit': 'pnpm run quality' } } : {}
      const facts = readHookFacts(root, packageJson, {}, COMMAND_FORMS)
      expect(facts.manager).toBe(expected)
      expect(hookCheck(evidence({ hooks: facts }))).toMatchObject({ state: 'present', level: 'L2' })
    }
  })

  it('reports a bare script with no manager as present at L0, and nothing at all as absent', () => {
    const root = scratch()
    const bare = readHookFacts(root, {}, { precommit: 'pnpm run quality' }, COMMAND_FORMS)
    expect(bare).toEqual({ manager: null, script: 'precommit', runsHarness: false })
    expect(hookCheck(evidence({ hooks: bare }))).toMatchObject({ state: 'present', level: 'L0' })
    expect(hookCheck(evidence({ hooks: readHookFacts(root, {}, {}, COMMAND_FORMS) }))).toMatchObject({ state: 'absent', level: 'L0' })
  })
})

describe('the red-gate check', () => {
  it('is always unknown and says doctor executes nothing', () => {
    for (const facts of [evidence(), evidence({ workflows: { directory: '.github/workflows', files: [], harnessWorkflow: null, unreadable: [] } })]) {
      const verdict = redGateCheck(facts)
      expect(verdict.state).toBe('unknown')
      expect(verdict.evidence).toContain('doctor executes nothing')
    }
  })
})

describe('the weakest link', () => {
  it('is the lowest level among the gates the repository claims, ties going to the canonical order', () => {
    const checks = [
      lintPolicyCheck(evidence()),
      constructTestsCheck(evidence()),
      ciCheck(evidence()),
      hookCheck(evidence({ hooks: { manager: 'lefthook.yml', script: null, runsHarness: true } })),
      redGateCheck(evidence()),
    ]
    expect(weakestLink(checks)).toEqual({ id: 'hook', level: 'L2' })
    expect(weakestLink(checks.filter(check => check.id !== 'hook'))).toEqual({ id: 'lint-policy', level: 'L3' })
    expect(weakestLink(checks.filter(check => check.state !== 'present'))).toBeNull()
    expect(checks.map(check => check.level)).not.toContain('L4')
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

  it('reports the runner config and whether the harness runs it', () => {
    const root = scratch()
    expect(readRunnerFacts(root, 'pnpm lint').globs).toBeNull()
    write(root, 'vitest.config.ts', 'export default { test: { include: [\'tests/**/*.test.ts\'] } }')
    const facts = readRunnerFacts(root, 'pnpm lint && vitest run')
    expect(facts).toMatchObject({ file: 'vitest.config.ts', globs: ['tests/**/*.test.ts'], invokedByHarness: true })
    expect(readRunnerFacts(root, 'pnpm lint').invokedByHarness).toBe(false)
  })
})

describe('reading the workflows without executing them', () => {
  it('finds the workflow whose run step invokes the harness command', () => {
    const root = scratch()
    write(root, '.github/workflows/security.yml', 'jobs:\n  audit:\n    steps:\n      - run: pnpm audit\n')
    write(root, '.github/workflows/ci.yml', 'jobs:\n  quality:\n    steps:\n      - name: Quality\n        run: |\n          pnpm install\n          pnpm run quality\n')
    const facts = readWorkflowFacts(root, COMMAND_FORMS)
    expect(facts.files).toEqual(['ci.yml', 'security.yml'])
    expect(facts.harnessWorkflow).toBe('.github/workflows/ci.yml')
  })

  it('reports no workflow directory as no files, never as an error', () => {
    expect(readWorkflowFacts(scratch(), COMMAND_FORMS)).toMatchObject({ files: [], harnessWorkflow: null })
  })
})

describe('the per-preset typecheck caveat', () => {
  it('warns only for the presets where a bare tsc cannot carry the stack', () => {
    expect(typecheckWarnings('node-backend', evidence())).toEqual([])
    expect(typecheckWarnings('node-frontend', evidence())[0]).toContain('vue-tsc')
  })

  it('stays quiet once the harness already runs the framework checker', () => {
    const harness = { ...evidence().harness, resolved: 'vue-tsc --noEmit && vitest run' }
    expect(typecheckWarnings('node-frontend', evidence({ harness }))).toEqual([])
  })
})
