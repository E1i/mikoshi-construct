import { appendFileSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { CHANGELOG_PATH, parseChangelog, REPO_ROOT } from './changelog.js'

export const RELEASE_BODY_BUDGET = 100_000
export const GITHUB_RELEASE_BODY_LIMIT = 125_000
export const DEFAULT_REPOSITORY = 'E1i/mikoshi-construct'

export const SUMMARY_LINE_LIMIT = 280

const CHANGESET_START = /^- /
const SECTION_HEADING = /^#{3,} /
const CHANGESETS_PREFIX = /^- (\[#\d+\]\([^)]*\) )?(?:\[`[0-9a-f]+`\]\([^)]*\) )?(?:Thanks [^!]*! - )?/
const FIRST_SENTENCE = /^.+?[.!?](?=\s|$)/
const ELLIPSIS = '…'
const BACKTICK = '`'

function shortened(text: string): string {
  const sentence = FIRST_SENTENCE.exec(text)?.[0] ?? text
  if (sentence.length <= SUMMARY_LINE_LIMIT)
    return sentence
  const cut = sentence.slice(0, SUMMARY_LINE_LIMIT)
  const atWord = cut.slice(0, Math.max(cut.lastIndexOf(' '), SUMMARY_LINE_LIMIT / 2)).trimEnd()
  const unclosedCode = atWord.split(BACKTICK).length % 2 === 0
  return `${atWord}${unclosedCode ? BACKTICK : ''}${ELLIPSIS}`
}

export function summaryLine(changesetLine: string): string {
  const prefix = CHANGESETS_PREFIX.exec(changesetLine)
  const pullRequest = prefix?.[1] ?? ''
  return `- ${pullRequest}${shortened(changesetLine.slice(prefix?.[0].length ?? 2).trim())}`
}

export interface ReleaseSource {
  version: string
  changelog: string
}

export type ReleaseBody
  = | { kind: 'within', version: string, body: string }
    | { kind: 'over-budget', version: string, body: string, budget: number }
    | { kind: 'absent', version: string }

export function releaseTag(version: string): string {
  return `v${version}`
}

export function changelogAtTag(version: string, repository = DEFAULT_REPOSITORY): string {
  return `https://github.com/${repository}/blob/${releaseTag(version)}/CHANGELOG.md#${version.replaceAll('.', '')}`
}

export function changesetFirstLines(entryBody: string): string[] {
  const lines = entryBody.split('\n').filter(line => SECTION_HEADING.test(line) || CHANGESET_START.test(line))
  const kept = lines.filter((line, index) => !SECTION_HEADING.test(line) || CHANGESET_START.test(lines[index + 1] ?? ''))
  return kept.map(line => (SECTION_HEADING.test(line) ? `\n${line}\n` : summaryLine(line)))
}

export function renderReleaseBody(source: ReleaseSource, repository = DEFAULT_REPOSITORY, budget = RELEASE_BODY_BUDGET): ReleaseBody {
  const entry = parseChangelog(source.changelog).find(candidate => candidate.version === source.version)
  if (entry === undefined)
    return { kind: 'absent', version: source.version }
  const link = `[CHANGELOG.md at ${releaseTag(source.version)}](${changelogAtTag(source.version, repository)})`
  const lead = `The first sentence of every changeset in ${source.version}; the full entry is in ${link}.`
  const body = `${[lead, ...changesetFirstLines(entry.body)].join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`
  return body.length <= budget
    ? { kind: 'within', version: source.version, body }
    : { kind: 'over-budget', version: source.version, body, budget }
}

export function readReleaseSource(root = REPO_ROOT): ReleaseSource {
  const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string }
  const changelog = readFileSync(path.join(root, path.basename(CHANGELOG_PATH)), 'utf8')
  return { version: manifest.version, changelog }
}

export function releaseBodyFault(rendered: ReleaseBody): string | null {
  if (rendered.kind === 'absent')
    return `CHANGELOG.md has no entry for ${rendered.version}, so the GitHub release of ${releaseTag(rendered.version)} has no body to render.`
  if (rendered.kind === 'over-budget')
    return `The GitHub release body of ${releaseTag(rendered.version)} is ${rendered.body.length} characters, over the budget of ${rendered.budget} (GitHub refuses a body over ${GITHUB_RELEASE_BODY_LIMIT}). Shorten the first line of the longest changesets.`
  return null
}

export const RELEASE_BODY_FILE = 'release-body.md'

export function releaseOutputs(rendered: ReleaseBody & { kind: 'within' }, bodyFile: string): string {
  return `tag=${releaseTag(rendered.version)}\nbody-file=${bodyFile}\n`
}

function writeReleaseBody(): void {
  const rendered = renderReleaseBody(readReleaseSource(), process.env.GITHUB_REPOSITORY ?? DEFAULT_REPOSITORY)
  if (rendered.kind !== 'within') {
    console.log(`::error::${releaseBodyFault(rendered)}`)
    process.exitCode = 1
    return
  }
  const bodyFile = process.argv[2] ?? RELEASE_BODY_FILE
  writeFileSync(bodyFile, rendered.body)
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, releaseOutputs(rendered, bodyFile))
  console.log(`The GitHub release body of ${releaseTag(rendered.version)} is ${rendered.body.length} characters, written to ${bodyFile}.`)
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url))
  writeReleaseBody()
