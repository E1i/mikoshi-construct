export type JobResult = 'success' | 'failure' | 'cancelled' | 'skipped'

export interface Needs { [job: string]: { result: JobResult, outputs?: Record<string, string> } }

export interface RunJob {
  name?: string
  runner_name?: string | null
  steps?: readonly unknown[]
}

export const CLASSIFY_JOB = 'changes'
export const REQUIRED_JOB = 'required'
export const SKIPPED_ON_FAST_PATH: readonly string[] = ['acceptance']
export const ABANDONED = 'abandoned'
export const ABANDONED_TITLE = 'CI abandoned'

const RERUN_RESULTS: readonly string[] = [ABANDONED, 'cancelled']

function jobsOfNeed(jobs: readonly RunJob[], need: string): RunJob[] {
  return jobs.filter(job => job.name === need || job.name?.startsWith(`${need} `) === true)
}

function gotARunner(job: RunJob): boolean {
  return (job.steps?.length ?? 0) > 0 || (job.runner_name ?? '') !== ''
}

export function ranNeeds(needs: Needs, jobs: readonly RunJob[] | null): ReadonlySet<string> | null {
  if (jobs === null || !jobs.some(job => job.name === REQUIRED_JOB && gotARunner(job)))
    return null
  const greenWithNoJob = Object.entries(needs).some(([need, { result }]) => result === 'success' && jobsOfNeed(jobs, need).length === 0)
  if (greenWithNoJob)
    return null
  return new Set(Object.keys(needs).filter(need => jobsOfNeed(jobs, need).some(gotARunner)))
}

function resultOf(job: string, result: JobResult, ran: ReadonlySet<string> | null): string {
  return result === 'failure' && ran !== null && !ran.has(job) ? ABANDONED : result
}

export function blockingJobs(needs: Needs, ran: ReadonlySet<string> | null = null): string[] {
  if (Object.keys(needs).length === 0)
    return ['no job results were passed in']
  const fastPath = needs[CLASSIFY_JOB]?.outputs?.['fast-path'] === 'true'
  return Object.entries(needs)
    .filter(([job, { result }]) => result !== 'success' && !(result === 'skipped' && fastPath && SKIPPED_ON_FAST_PATH.includes(job)))
    .map(([job, { result }]) => `${job}: ${resultOf(job, result, ran)}`)
}

function resultNamed(blocking: string): string {
  return blocking.slice(blocking.lastIndexOf(': ') + 2)
}

export function rerunDue(blocking: readonly string[]): boolean {
  const results = blocking.map(resultNamed)
  return results.includes(ABANDONED) && results.every(result => RERUN_RESULTS.includes(result))
}

export function requiredSummary(blocking: readonly string[]): string {
  if (blocking.length === 0)
    return 'CI / required is green.'
  if (rerunDue(blocking))
    return `CI / required is red only from jobs GitHub abandoned or cancelled, not from a defect; a rerun is due: ${blocking.join(', ')}`
  return `CI / required is red: ${blocking.join(', ')}`
}
