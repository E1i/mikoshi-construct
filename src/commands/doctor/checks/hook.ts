import type { DoctorEvidence } from '../evidence.js'
import type { CheckVerdict } from '../verdict.js'

const ID = 'hook'

export function hookCheck(evidence: DoctorEvidence): CheckVerdict {
  const hooks = evidence.hooks
  if (hooks.manager != null) {
    const runs = hooks.runsHarness ? `runs "${evidence.harness.command}"` : `does not run "${evidence.harness.command}"`
    return { id: ID, level: 'L2', state: 'present', evidence: `${hooks.manager} installs a git hook and ${runs}; a local hook is bypassable with --no-verify` }
  }
  if (hooks.script != null)
    return { id: ID, level: 'L0', state: 'present', evidence: `package.json script "${hooks.script}" is claimed as a guard, but no .husky, lefthook, simple-git-hooks or core.hooksPath configuration installs it; weakest link: nobody is obliged to run it` }
  return { id: ID, level: 'L0', state: 'absent', evidence: 'no .husky, lefthook, simple-git-hooks or core.hooksPath configuration and no pre-commit script in package.json' }
}
