import { stripVTControlCharacters } from 'node:util'

export interface FailedJobLog {
  log: string
  jobLink: string | null
}

export const CI_LOG_CEILING = 20_000
const TAIL_CEILING = 5_000
const LINES_BEFORE_FAILURE = 2
const LINES_AFTER_FAILURE = 20

const JOB_STEP_AND_STAMP = /^(?:[^\t]*\t[^\t]*\t)?\uFEFF?(?:\d{4}-\d{2}-\d{2}T[\d:.]+Z ?)?/
const FAILURE_MARKER = /\b(?:FAIL(?:ED)?|ERROR)\b|\b\w*Error\b|##\[error\]/
const GREEN_TEST = /^(?:[✓✔√]|PASS\b)/
const RUNNER_SETUP_PREFIXES = [
  '##[group]',
  '##[endgroup]',
  '[command]',
  'Current runner version',
  'Runner name',
  'Runner group name',
  'Runner Image',
  'Machine name',
  'Hosted Compute Agent',
  'Operating System',
  'Image:',
  'Image Release:',
  'Version:',
  'Included Software:',
  'GITHUB_TOKEN Permissions',
  'Secret source',
  'Prepare workflow directory',
  'Prepare all required actions',
  'Getting action download info',
  'Download action repository',
  'Download immutable action',
  'Complete job name',
  'Syncing repository',
  'Getting Git version info',
  'Temporarily overriding HOME',
  'Adding repository directory',
  'Deleting the contents',
  'Initializing the repository',
  'Disabling automatic garbage collection',
  'Setting up auth',
  'Fetching the repository',
  'Determining the checkout info',
  'Checking out the ref',
]

function messageOf(line: string): string {
  return line.replace(JOB_STEP_AND_STAMP, '').trimStart()
}

function isNoise(line: string): boolean {
  const message = messageOf(line)
  return GREEN_TEST.test(message) || RUNNER_SETUP_PREFIXES.some(prefix => message.startsWith(prefix))
}

function linesWorthReading(log: string): string[] {
  const all = log.split('\n')
  const kept = all.filter(line => !isNoise(line))
  return kept.some(line => messageOf(line) !== '') ? kept : all
}

function tailStart(lines: readonly string[]): number {
  let start = lines.length - 1
  let size = lines[start]!.length
  while (start > 0 && size + lines[start - 1]!.length < TAIL_CEILING) {
    start -= 1
    size += lines[start]!.length + 1
  }
  return start
}

function failureBlockLines(lines: readonly string[], end: number): string[] {
  const inBlock = new Set<number>()
  lines.forEach((line, at) => {
    if (FAILURE_MARKER.test(messageOf(line))) {
      for (let near = at - LINES_BEFORE_FAILURE; near <= at + LINES_AFTER_FAILURE; near += 1)
        inBlock.add(near)
    }
  })
  return lines.slice(0, end).filter((_, at) => inBlock.has(at))
}

function cutLine(characters: number, jobLink: string | null): string {
  return `cut: ${characters} characters, full log: ${jobLink ?? 'the job link is unread'}`
}

export function ciLogForPrompt({ log, jobLink }: FailedJobLog): string {
  const clean = stripVTControlCharacters(log).trimEnd()
  const room = CI_LOG_CEILING - cutLine(clean.length, jobLink).length - 1
  const lines = linesWorthReading(clean)
  const tailFrom = tailStart(lines)
  const tail = lines.slice(tailFrom).join('\n').slice(-TAIL_CEILING)
  const blocks = failureBlockLines(lines, tailFrom).join('\n').slice(0, room - tail.length - 1)
  const carried = blocks === '' ? tail : `${blocks}\n${tail}`
  return `${carried}\n${cutLine(clean.length - carried.length, jobLink)}`
}

export function failedJobLinkIn(jobsJson: string): string | null {
  try {
    const { jobs } = JSON.parse(jobsJson) as { jobs: { conclusion?: string, url?: string }[] }
    return jobs.find(job => job.conclusion === 'failure')?.url ?? null
  }
  catch {
    return null
  }
}
