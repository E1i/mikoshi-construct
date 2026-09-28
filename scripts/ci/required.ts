export type JobResult = 'success' | 'failure' | 'cancelled' | 'skipped'

export interface Needs { [job: string]: { result: JobResult, outputs?: Record<string, string> } }

export const CLASSIFY_JOB = 'changes'
export const SKIPPED_ON_FAST_PATH: readonly string[] = ['package', 'acceptance']

export function blockingJobs(needs: Needs): string[] {
  if (Object.keys(needs).length === 0)
    return ['no job results were passed in']
  const fastPath = needs[CLASSIFY_JOB]?.outputs?.['fast-path'] === 'true'
  return Object.entries(needs)
    .filter(([job, { result }]) => result !== 'success' && !(result === 'skipped' && fastPath && SKIPPED_ON_FAST_PATH.includes(job)))
    .map(([job, { result }]) => `${job}: ${result}`)
}
