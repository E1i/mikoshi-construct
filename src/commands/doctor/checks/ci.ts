import type { DoctorEvidence } from '../evidence.js'
import type { CheckVerdict } from '../verdict.js'
import { harnessReach } from '../enforcement.js'

const ID = 'ci'
const SCOPE = 'branch protection and organisation rulesets live in the GitHub API, not in the repository, so doctor cannot see whether this blocks a merge'

export function ciCheck(evidence: DoctorEvidence): CheckVerdict {
  const workflows = evidence.workflows
  const reach = harnessReach(evidence)
  if (workflows.harnessWorkflow != null)
    return { id: ID, level: reach.level, state: 'present', evidence: `${reach.evidence}; ${SCOPE}` }
  const seen = workflows.files.length === 0
    ? `${workflows.directory} holds no workflow file`
    : `none of ${workflows.files.map(file => `${workflows.directory}/${file}`).join(', ')} runs "${evidence.harness.command}"`
  return { id: ID, level: reach.level, state: 'unknown', evidence: `${seen}; ${SCOPE}` }
}
