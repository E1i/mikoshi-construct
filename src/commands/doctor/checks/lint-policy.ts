import type { DoctorEvidence } from '../evidence.js'
import type { CheckVerdict } from '../verdict.js'
import { absent, reached } from '../enforcement.js'
import { matchesAnyGlob } from '../runner.js'

const ID = 'lint-policy'

export function lintPolicyCheck(evidence: DoctorEvidence): CheckVerdict {
  const policy = evidence.policyTests[0]
  if (policy == null) {
    if (evidence.unreadable.length > 0)
      return reached(ID, 'unknown', evidence, `${evidence.unreadable[0]} cannot be read, so doctor cannot say whether a lint policy check exists`)
    return absent(ID, 'no file recorded in construct.json runs ESLint over the lint policy this repository declares; weakest link: the repository has no policy check to run')
  }
  const runner = evidence.runner
  if (runner.globs == null)
    return reached(ID, 'unknown', evidence, `${policy} runs ESLint over the lint policy this repository declares, but ${runner.note}`)
  if (!matchesAnyGlob(policy, runner.globs))
    return absent(ID, `${policy} runs ESLint over the lint policy this repository declares, but ${runner.note}; weakest link: the runner never collects the policy check`)
  if (!runner.invokedByHarness)
    return absent(ID, `${policy} runs ESLint over the lint policy this repository declares and ${runner.note}, but "${evidence.harness.script}" does not run the test runner; weakest link: the harness command never reaches the policy check`)
  return reached(ID, 'present', evidence, `${policy} runs ESLint over the lint policy this repository declares, ${runner.note}, and "${evidence.harness.script}" runs the test runner`)
}
