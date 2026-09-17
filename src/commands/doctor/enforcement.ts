import type { DoctorEvidence } from './evidence.js'
import type { CheckId, CheckState, CheckVerdict, Level } from './verdict.js'

export interface HarnessReach {
  level: Level
  evidence: string
}

export function harnessReach(evidence: DoctorEvidence): HarnessReach {
  const command = `"${evidence.harness.command}"`
  if (evidence.workflows.harnessWorkflow != null)
    return { level: 'L3', evidence: `${evidence.workflows.harnessWorkflow} runs ${command}` }
  if (evidence.hooks.runsHarness && evidence.hooks.manager != null)
    return { level: 'L2', evidence: `${evidence.hooks.manager} runs ${command}, and a local hook is bypassable with --no-verify` }
  return { level: 'L0', evidence: `no workflow and no hook configuration runs ${command}` }
}

export function reached(id: CheckId, state: Exclude<CheckState, 'absent'>, evidence: DoctorEvidence, detail: string): CheckVerdict {
  const reach = harnessReach(evidence)
  return { id, level: reach.level, state, evidence: `${detail}; ${reach.evidence}` }
}

export function absent(id: CheckId, detail: string): CheckVerdict {
  return { id, level: 'L0', state: 'absent', evidence: detail }
}
