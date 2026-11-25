import type { ReleaseSource } from '../../release-notes/release-body.js'
import type { SmokeReading, StatusesFetch } from '../../release/version-pr-guard.js'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { RELEASE_BODY_BUDGET, SUMMARY_LINE_LIMIT } from '../../release-notes/release-body.js'
import { SMOKE_STATUS_CONTEXT } from '../../release/consumer-smoke.js'
import { guardVersionPr, readSmokeStatus } from '../../release/version-pr-guard.js'

const GREEN_SMOKE: SmokeReading = { state: 'success', note: '22 steps green' }

function changesetDir(files: string[]): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'construct-version-pr-'))
  for (const name of files)
    writeFileSync(path.join(dir, name), '')
  return dir
}

describe('a version pull request cannot merge over a changeset it has not consumed', () => {
  it('refuses changeset-release/main while the merged tree carries a pending changeset, naming it and what to do', () => {
    const dir = changesetDir(['README.md', 'config.json', 'olive-pugs-repeat.md'])

    const verdict = guardVersionPr('changeset-release/main', dir)

    expect(verdict.passed).toBe(false)
    const text = verdict.lines.join('\n')
    expect(text).toContain(`${dir}/olive-pugs-repeat.md`)
    expect(text).not.toContain('README.md')
    expect(text).toMatch(/wait for the release bot to update the version pull request/)
  })

  it('names every pending changeset, not only the first', () => {
    const dir = changesetDir(['config.json', 'olive-pugs-repeat.md', 'ninety-nine-moles-sit.md'])

    const text = guardVersionPr('changeset-release/main', dir).lines.join('\n')

    expect(text).toContain('olive-pugs-repeat.md')
    expect(text).toContain('ninety-nine-moles-sit.md')
  })

  it('passes changeset-release/main once every changeset is consumed', () => {
    expect(guardVersionPr('changeset-release/main', changesetDir(['README.md', 'config.json']), changelogOf('9.9.9', 1, 'Short.'), GREEN_SMOKE).passed).toBe(true)
  })

  it('passes any other branch carrying a pending changeset, which is the ordinary feature pull request', () => {
    expect(guardVersionPr('version-pr-guard', changesetDir(['config.json', 'olive-pugs-repeat.md'])).passed).toBe(true)
  })

  it('passes a run with no pull request head, as push and merge_group runs have', () => {
    expect(guardVersionPr(undefined, changesetDir(['olive-pugs-repeat.md'])).passed).toBe(true)
    expect(guardVersionPr('', changesetDir(['olive-pugs-repeat.md'])).passed).toBe(true)
  })
})

function changelogOf(version: string, changesets: number, sentence: string): () => ReleaseSource {
  const bullets = Array.from({ length: changesets }, (_, index) => `- [#${index}](https://github.com/o/r/pull/${index}) ${sentence}`)
  return () => ({ version, changelog: `# pkg\n\n## ${version}\n\n### Patch Changes\n\n${bullets.join('\n\n')}\n` })
}

describe('a version pull request renders its GitHub release body within the budget', () => {
  const consumed = (): string => changesetDir(['README.md', 'config.json'])

  it('a version pull request whose release body exceeds the budget is red', () => {
    const release = changelogOf('9.9.9', Math.ceil(RELEASE_BODY_BUDGET / SUMMARY_LINE_LIMIT) * 2, `${'word '.repeat(SUMMARY_LINE_LIMIT / 5)}.`)

    const verdict = guardVersionPr('changeset-release/main', consumed(), release)

    expect(verdict.passed).toBe(false)
    const text = verdict.lines.join('\n')
    expect(text).toContain('v9.9.9')
    expect(text).toContain(`over the budget of ${RELEASE_BODY_BUDGET}`)
    expect(text).toMatch(/### Patch Changes: \d+ changesets, \d+ characters/)
  })

  it('passes a version pull request whose release body fits the budget', () => {
    expect(guardVersionPr('changeset-release/main', consumed(), changelogOf('9.9.9', 3, 'Short.'), GREEN_SMOKE).passed).toBe(true)
  })

  it('is red when the changelog carries no entry for the version being released', () => {
    const verdict = guardVersionPr('changeset-release/main', consumed(), () => ({ version: '9.9.9', changelog: '# pkg\n\n## 9.9.8\n\n- x.\n' }))

    expect(verdict.passed).toBe(false)
    expect(verdict.lines.join('\n')).toContain('no entry for 9.9.9')
  })

  it('does not render the release body on a pull request that is not a version pull request', () => {
    const release = (): ReleaseSource => {
      throw new Error('read on a feature pull request')
    }
    expect(guardVersionPr('feature', consumed(), release).passed).toBe(true)
  })
})

function eventFile(sha: string): string {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'construct-version-pr-event-')), 'event.json')
  writeFileSync(file, JSON.stringify({ pull_request: { head: { sha } } }))
  return file
}

function statusesAnswer(statuses: unknown, status = 200): { fetch: StatusesFetch, urls: string[] } {
  const urls: string[] = []
  const fetch: StatusesFetch = async (url) => {
    urls.push(url)
    return { ok: status === 200, status, json: async () => statuses }
  }
  return { fetch, urls }
}

describe('a version pull request is red until the consumer smoke is green on its head', () => {
  const consumed = (): string => changesetDir(['README.md', 'config.json'])
  const release = changelogOf('9.9.9', 1, 'Short.')

  it('a version PR whose head has no green consumer smoke is red', () => {
    const readings: SmokeReading[] = [
      { state: 'missing', note: 'the factory has posted no consumer smoke for this head' },
      { state: 'failure', note: 'red: launch git-commit' },
      { state: 'pending', note: 'running' },
      { state: 'unread', note: 'HTTP 403' },
    ]
    for (const smoke of readings) {
      const verdict = guardVersionPr('changeset-release/main', consumed(), release, smoke)
      expect(verdict.passed, smoke.state).toBe(false)
      const text = verdict.lines.join('\n')
      expect(text).toContain(`${SMOKE_STATUS_CONTEXT} is ${smoke.state} (${smoke.note})`)
      expect(text).toContain('not shipped as working')
      expect(text).toContain('scripts/release/consumer-smoke.ts')
    }
    expect(guardVersionPr('changeset-release/main', consumed(), release).passed).toBe(false)
  })

  it('passes once the head carries a green consumer smoke', () => {
    expect(guardVersionPr('changeset-release/main', consumed(), release, GREEN_SMOKE).passed).toBe(true)
  })

  it('does not ask for a smoke on an ordinary feature pull request', () => {
    expect(guardVersionPr('feature', consumed(), release).passed).toBe(true)
  })

  it('reads the newest consumer smoke status the factory posted on the pull request head', async () => {
    const { fetch, urls } = statusesAnswer([
      { context: 'ci/other', state: 'success' },
      { context: SMOKE_STATUS_CONTEXT, state: 'success', description: '22 steps green' },
      { context: SMOKE_STATUS_CONTEXT, state: 'failure', description: 'red: window codex' },
    ])

    const reading = await readSmokeStatus({ GITHUB_REPOSITORY: 'o/r', GITHUB_EVENT_PATH: eventFile('abc123') }, fetch)

    expect(reading).toEqual({ state: 'success', note: '22 steps green' })
    expect(urls).toEqual(['https://api.github.com/repos/o/r/commits/abc123/statuses?per_page=100'])
  })

  it('reads a head with no smoke status as missing, and an unreadable answer as unread, never as green', async () => {
    const env = { GITHUB_REPOSITORY: 'o/r', GITHUB_EVENT_PATH: eventFile('abc123') }

    expect((await readSmokeStatus(env, statusesAnswer([{ context: 'ci/other', state: 'success' }]).fetch)).state).toBe('missing')
    const refused = await readSmokeStatus(env, statusesAnswer([], 403).fetch)
    expect(refused.state).toBe('unread')
    expect(refused.note).toContain('HTTP 403')
    expect((await readSmokeStatus({ GITHUB_REPOSITORY: 'o/r' }, statusesAnswer([]).fetch)).state).toBe('unread')
  })
})
