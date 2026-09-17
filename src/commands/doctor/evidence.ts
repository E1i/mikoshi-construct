import type { Manifest } from '../../manifest.js'
import type { HarnessFacts } from './harness.js'
import type { HookFacts } from './hooks.js'
import type { RunnerFacts } from './runner.js'
import type { WorkflowFacts } from './workflows.js'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { readHarnessFacts } from './harness.js'
import { readHookFacts } from './hooks.js'
import { readRunnerFacts } from './runner.js'
import { readWorkflowFacts } from './workflows.js'

export interface DoctorEvidence {
  harness: HarnessFacts
  runner: RunnerFacts
  workflows: WorkflowFacts
  hooks: HookFacts
  recordedTests: string[]
  policyTests: string[]
  unreadable: string[]
}

const TEST_FILE = /\.test\.[cm]?[jt]s$/
const LINT_POLICY_MARKERS = ['calculateConfigForFile', 'lintText', 'lintFiles']

function recordedTestFiles(manifest: Manifest): string[] {
  return Object.keys(manifest.files).filter(file => TEST_FILE.test(file)).sort()
}

export function gatherEvidence(root: string, manifest: Manifest): DoctorEvidence {
  const harness = readHarnessFacts(root, manifest.harness.command)
  const runner = readRunnerFacts(root, harness.resolved)
  const workflows = readWorkflowFacts(root, harness.commandForms)
  const hooks = readHookFacts(root, harness.packageJson, harness.scripts, harness.commandForms)
  const recordedTests = recordedTestFiles(manifest)
  const policyTests: string[] = []
  const unreadable: string[] = [...workflows.unreadable]
  for (const file of recordedTests) {
    try {
      const source = readFileSync(path.join(root, file), 'utf8')
      if (LINT_POLICY_MARKERS.some(marker => source.includes(marker)))
        policyTests.push(file)
    }
    catch {
      unreadable.push(file)
    }
  }
  return { harness, runner, workflows, hooks, recordedTests, policyTests, unreadable }
}
