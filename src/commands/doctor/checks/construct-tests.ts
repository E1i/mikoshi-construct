import type { DoctorEvidence } from '../evidence.js'
import type { CheckVerdict } from '../verdict.js'
import { absent, reached } from '../enforcement.js'
import { matchesAnyGlob } from '../runner.js'

const ID = 'construct-tests'

export function constructTestsCheck(evidence: DoctorEvidence): CheckVerdict {
  const recorded = evidence.recordedTests
  if (recorded.length === 0)
    return absent(ID, 'construct.json records no test file; weakest link: there are no construct tests to run')
  const runner = evidence.runner
  if (runner.globs == null)
    return reached(ID, 'unknown', evidence, `construct.json records ${recorded.length} test files, but ${runner.note}`)
  const orphan = recorded.find(file => !matchesAnyGlob(file, runner.globs ?? []))
  if (orphan != null)
    return absent(ID, `${orphan} is recorded in construct.json, but ${runner.note}, so the runner never collects it; weakest link: a construct test that nothing runs`)
  if (!runner.invokedByHarness)
    return absent(ID, `construct.json records ${recorded.length} test files and ${runner.note}, but "${evidence.harness.script}" does not run the test runner; weakest link: the harness command never reaches them`)
  return reached(ID, 'present', evidence, `all ${recorded.length} test files recorded in construct.json match the include in ${runner.file}, and "${evidence.harness.script}" runs the test runner`)
}
