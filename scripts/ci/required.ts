export type JobResult = 'success' | 'failure' | 'cancelled' | 'skipped'

export interface Needs { [job: string]: { result: JobResult, outputs?: Record<string, string> } }

export const DOCS_ONLY_JOB = 'changes'
export const SKIPPED_WHEN_DOCS_ONLY = 'acceptance'

const DOCS_ONLY_PATH = /^(?:\.changeset\/|docs\/|CHANGELOG\.md$)/

export function isDocsOnly(paths: readonly string[]): boolean {
  return paths.length > 0 && paths.every(file => DOCS_ONLY_PATH.test(file))
}

export function blockingJobs(needs: Needs): string[] {
  if (Object.keys(needs).length === 0)
    return ['no job results were passed in']
  const docsOnly = needs[DOCS_ONLY_JOB]?.outputs?.['docs-only'] === 'true'
  return Object.entries(needs)
    .filter(([job, { result }]) => result !== 'success' && !(result === 'skipped' && docsOnly && job === SKIPPED_WHEN_DOCS_ONLY))
    .map(([job, { result }]) => `${job}: ${result}`)
}
