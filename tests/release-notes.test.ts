import type { GhCaller } from '../scripts/ports/gh.js'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import config from '../docs/.vitepress/config.js'
import { GH_PORT, stepCallsGitHub } from '../scripts/core/gh-callers.js'
import { readGhJson } from '../scripts/ports/gh.js'
import { CHANGELOG_PATH, handWrittenNotes, INDEX_PATH, parseChangelog, releaseAnchor, releaseSidebarItems } from '../scripts/release-notes/changelog.js'
import { parseNotices, unansweredNotices } from '../scripts/release-notes/notices.js'
import { renderIndex } from '../scripts/release-notes/render.js'
import { packageScripts, resolvedScript } from './package-scripts.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const CHANGELOG = readFileSync(CHANGELOG_PATH, 'utf8')

interface NavItem {
  link?: string
  items?: NavItem[]
}

function links(items: NavItem[]): string[] {
  return items.flatMap(item => [...(item.link == null ? [] : [item.link]), ...links(item.items ?? [])])
}

function newestFirst(left: string, right: string): number {
  const [a, b] = [left, right].map(version => version.split('.').map(Number))
  return (b[0] - a[0]) || (b[1] - a[1]) || (b[2] - a[2])
}

function wiredLinks(): string[] {
  const theme = config.themeConfig as { nav?: NavItem[], sidebar?: NavItem[] }
  return [...links(theme.nav ?? []), ...links(theme.sidebar ?? [])]
}

function pageSource(link: string): string | null {
  const file = path.join(REPO_ROOT, 'docs', link.endsWith('/') ? `${link}index.md` : `${link}.md`)
  return existsSync(file) ? readFileSync(file, 'utf8') : null
}

function versionsOn(link: string): string[] {
  const source = pageSource(link)
  if (source == null)
    return []
  const own = /\/release-notes\/(\d+\.\d+\.\d+)$/.exec(link)
  const headings = [...source.matchAll(/^#{1,2} (\d+\.\d+\.\d+)\b/gm)].map(match => match[1])
  return [...(own == null ? [] : [own[1]]), ...headings]
}

function unreachableVersions(versions: string[], wired: string[]): string[] {
  const reachable = new Set(wired.flatMap(link => versionsOn(link)))
  return versions.filter(version => !reachable.has(version))
}

describe('every released version is reachable from the documentation site', () => {
  const versions = parseChangelog(CHANGELOG).map(entry => entry.version)

  it('reads more than one version out of the changelog, so an empty list cannot pass for a site that carries them all', () => {
    expect(versions.length).toBeGreaterThan(5)
    expect(versions).toContain('0.8.0')
  })

  it('finds every version the changelog carries on a page the nav or the sidebar links', () => {
    expect(unreachableVersions(versions, wiredLinks())).toEqual([])
  })

  it('goes red for a version added to the changelog and wired nowhere', () => {
    expect(unreachableVersions([...versions, '9.9.9'], wiredLinks())).toEqual(['9.9.9'])
  })

  it('goes red when the wiring for an existing version is removed', () => {
    const withoutIndex = wiredLinks().filter(link => link !== '/release-notes/')
    expect(unreachableVersions(versions, withoutIndex)).toContain('0.8.0')
    expect(unreachableVersions(versions, withoutIndex)).not.toContain('0.5.0')
    const withoutPage = withoutIndex.filter(link => link !== '/release-notes/0.5.0')
    expect(unreachableVersions(versions, withoutPage)).toContain('0.5.0')
  })
})

describe('the release index is rendered from the changelog, not maintained by hand', () => {
  it('matches what the renderer produces from the current changelog, so a release landing without regeneration fails', () => {
    expect(readFileSync(INDEX_PATH, 'utf8')).toBe(renderIndex(parseChangelog(CHANGELOG), handWrittenNotes()))
  })

  it('links a version with a hand-written note instead of repeating it, and carries the changelog entry for the rest', () => {
    const rendered = renderIndex(parseChangelog(CHANGELOG), handWrittenNotes())
    expect(rendered).toContain('](/release-notes/0.5.0)')
    expect(rendered).not.toContain('If you are upgrading, do this first')
    expect(rendered).toContain('## 0.8.0')
  })

  it('orders a two-digit minor above a single-digit one, which a string comparison inverts', () => {
    const versions = ['0.10.0', '0.9.1', '0.9.0', '0.8.1']
    expect([...versions].sort(newestFirst)).toEqual(versions)
    expect([...versions].sort().reverse()).not.toEqual(versions)
  })

  it('reads the changelog order rather than sorting it, so the assertion and the data cannot share one wrong comparison', () => {
    const fromChangelog = parseChangelog(CHANGELOG).map(entry => entry.version)
    expect(fromChangelog).toEqual([...fromChangelog].sort(newestFirst))
    expect(renderIndex(parseChangelog(CHANGELOG), handWrittenNotes())).toContain(fromChangelog[0])
  })

  it('lists the versions newest first, in the order the changelog carries them', () => {
    const order = [...renderIndex(parseChangelog(CHANGELOG), handWrittenNotes()).matchAll(/^## (\d+\.\d+\.\d+)$/gm)].map(match => match[1])
    expect(order).toEqual(parseChangelog(CHANGELOG).map(entry => entry.version))
    expect(order.length).toBeGreaterThan(1)
    expect(order).toEqual([...order].sort(newestFirst))
    expect([...order].sort(newestFirst)).not.toEqual([...order].reverse())
  })
})

describe('the step that writes the changelog regenerates the page rendered from it', () => {
  const RENDERER = 'scripts/release-notes/sync-docs.ts'

  function versionScript(): string {
    const workflow = readFileSync(path.join(REPO_ROOT, '.github/workflows/release.yml'), 'utf8')
    return /version-script:\s*pnpm (?:run )?([\w:-]+)/.exec(workflow)?.[1] ?? ''
  }

  it('names a version script the release workflow actually runs', () => {
    expect(versionScript()).not.toBe('')
    expect(packageScripts()[versionScript()]).toBeDefined()
  })

  it('reaches the renderer from that script, so a release cannot bump the changelog and leave the page behind', () => {
    expect(resolvedScript(versionScript(), packageScripts())).toContain(RENDERER)
  })

  it('goes red when the version script stops reaching the renderer, which is how every release turned red before', () => {
    const withoutRender = { ...packageScripts(), [versionScript()]: 'changeset version' }
    expect(resolvedScript(versionScript(), withoutRender)).not.toContain(RENDERER)
  })
})

describe('the releases sublist names the latest releases, not only the hand-written ones', () => {
  function sublist(): { text: string, link: string }[] {
    const theme = config.themeConfig as { sidebar?: { text?: string, items?: { text: string, link: string }[] }[] }
    return (theme.sidebar ?? []).find(group => group.text === 'Releases')?.items ?? []
  }

  it('names the newest version the changelog carries, so a release cannot leave the navigation on an older one', () => {
    const newest = parseChangelog(CHANGELOG)[0].version
    expect(sublist().some(item => item.text.startsWith(newest))).toBe(true)
  })

  it('keeps every hand-written note of a released version named, because it is the better artifact where it exists', () => {
    const versions = parseChangelog(CHANGELOG).map(entry => entry.version)
    for (const version of [...handWrittenNotes().keys()].filter(version => versions.includes(version)))
      expect(sublist().map(item => item.link), version).toContain(`/release-notes/${version}`)
  })

  it('leaves out a note written ahead of the version pull request until the changelog carries its version', () => {
    const notes = new Map([['9.9.0', '9.9.0 — ahead'], ['1.0.0', '1.0.0 — out']])
    const links = releaseSidebarItems(['1.0.0'], notes).map(item => item.link)
    expect(links).toEqual(['/release-notes/1.0.0'])
  })

  it('points a version without a note at its own section, and names only versions the changelog carries', () => {
    const versions = parseChangelog(CHANGELOG).map(entry => entry.version)
    const anchored = sublist().filter(item => item.link.includes('#'))
    expect(anchored.length).toBeGreaterThan(0)
    for (const item of anchored) {
      expect(versions, item.link).toContain(item.text)
      expect(item.link, item.link).toBe(releaseAnchor(item.text))
    }
  })
})

describe('the harness runs on every change, so the gates inside it cannot sit off the path', () => {
  const WORKFLOW = readFileSync(path.join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8')

  function triggerBlock(): string {
    const start = WORKFLOW.indexOf('\non:')
    const rest = WORKFLOW.slice(start + 1)
    const end = rest.search(/\n[a-z][\w-]*:/)
    return end === -1 ? rest : rest.slice(0, end)
  }

  it('reads a trigger block that actually names pull_request, so the check is not looking at nothing', () => {
    expect(triggerBlock()).toContain('pull_request')
  })

  it('restricts the harness to no path, because a filter would take every gate inside it off the path of some change', () => {
    expect(triggerBlock()).not.toContain('paths')
  })

  it('goes red for a trigger block that filters by path, which is how a gate leaves the route without moving', () => {
    const filtered = triggerBlock().replace('pull_request:', 'pull_request:\n    paths:\n      - src/**')
    expect(filtered).toContain('paths')
    expect(triggerBlock()).not.toBe(filtered)
  })
})

describe('release does not run the whole quality in one process', () => {
  interface Step { name?: string, uses?: string, run?: string, env?: Record<string, unknown> }
  interface Job { needs?: string | string[], steps?: Step[] }
  interface Workflow { on?: { push?: { branches?: string[] } }, jobs?: Record<string, Job> }

  const QUALITY_JOBS = ['checks', 'lint', 'typecheck', 'vitest', 'docs']

  function workflow(name: string): Workflow {
    return parseYaml(readFileSync(path.join(REPO_ROOT, `.github/workflows/${name}`), 'utf8')) as Workflow
  }

  function runsQuality(step: Step): boolean {
    return /\bpnpm\s+(?:run\s+)?(?:quality|ci)\b/.test(step.run ?? '') && !/\bpnpm\s+ci\b/.test(step.run ?? '')
  }

  function gateFaults(release: Workflow, ci: Workflow): string[] {
    const steps = release.jobs?.release?.steps ?? []
    const publish = steps.findIndex(step => step.uses?.startsWith('changesets/action@') === true)
    const faults: string[] = []
    if (publish === -1)
      faults.push('no changesets step')
    if (steps.some(runsQuality))
      faults.push('runs quality in one process')
    const waits = steps.slice(0, Math.max(publish, 0)).filter(step => /check-runs\?check_name=/.test(step.run ?? ''))
    const check = waits.map(step => String(step.env?.CI_CHECK ?? '')).find(name => name !== '')
    if (check == null) {
      faults.push('no wait on a CI check before publishing')
    }
    else {
      const wait = waits.find(step => step.env?.CI_CHECK === check)!
      if (!/^\$\{\{\s*github\.sha\s*\}\}$/.test(String(wait.env?.SHA ?? '')))
        faults.push('waits on another commit')
      if (!/latest\?\.status === "completed" && latest\.conclusion === "success"\)\s*process\.exit\(0\)/.test(wait.run ?? ''))
        faults.push('does not require success')
      if (!(wait.run ?? '').includes(`./${GH_PORT}`))
        faults.push('does not read through the GitHub port')
      const needs = ci.jobs?.[check]?.needs ?? []
      const missing = QUALITY_JOBS.filter(job => !([needs].flat()).includes(job))
      if (missing.length > 0)
        faults.push(`${check} does not aggregate ${missing.join(', ')}`)
    }
    if (!(ci.on?.push?.branches ?? []).includes('main'))
      faults.push('CI does not run on a push to main')
    if (stepCallsGitHub(stringifyYaml(release)))
      faults.push('calls GitHub outside the port')
    return faults
  }

  const release = workflow('release.yml')
  const ci = workflow('ci.yml')

  it('release does not run the whole quality in one process', () => {
    expect(gateFaults(release, ci)).toEqual([])
  })

  it('goes red when the release job runs quality again', () => {
    const steps = [{ run: 'pnpm run quality' }, ...(release.jobs?.release?.steps ?? [])]
    expect(gateFaults({ ...release, jobs: { release: { steps } } }, ci)).toContain('runs quality in one process')
  })

  it('goes red when the wait on CI is removed or moved after the publish', () => {
    const steps = release.jobs?.release?.steps ?? []
    const without = steps.filter(step => step.env?.CI_CHECK == null)
    expect(gateFaults({ ...release, jobs: { release: { steps: without } } }, ci)).toContain('no wait on a CI check before publishing')
    const wait = steps.find(step => step.env?.CI_CHECK != null)!
    expect(gateFaults({ ...release, jobs: { release: { steps: [...without, wait] } } }, ci)).toContain('no wait on a CI check before publishing')
  })

  it('goes red when the wait calls gh in its step instead of the port', () => {
    const steps = (release.jobs?.release?.steps ?? []).map(step => step.env?.CI_CHECK == null ? step : { ...step, run: `gh api "repos/o/r/commits/$SHA/check-runs?check_name=required"\n` })
    const faults = gateFaults({ ...release, jobs: { release: { steps } } }, ci)
    expect(faults).toContain('calls GitHub outside the port')
    expect(faults).toContain('does not read through the GitHub port')
  })

  it('goes red when the awaited CI job stops aggregating a quality job', () => {
    const jobs = { ...ci.jobs, required: { ...ci.jobs?.required, needs: ['changes', 'lint'] } }
    expect(gateFaults(release, { ...ci, jobs })).toContainEqual(expect.stringContaining('does not aggregate'))
  })
})

describe('the wait step stops the release unless the latest CI check on the commit succeeded', () => {
  interface CheckRun { id: number, status: string, conclusion: string | null, app?: { slug: string } }
  interface WaitOutcome { exit: number | 'still waiting', polls: number }

  const POLL_CAP = 1000
  const WAIT_SECONDS = 90
  const ACTIONS = { slug: 'github-actions' }

  type WaitBody = (gh: GhCaller, read: typeof readGhJson, proc: unknown, clock: unknown, sleep: unknown, log: unknown) => Promise<void>
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...params: string[]) => WaitBody

  function waitScript(): string {
    const release = parseYaml(readFileSync(path.join(REPO_ROOT, '.github/workflows/release.yml'), 'utf8')) as { jobs: { release: { steps: { run?: string, env?: Record<string, unknown> }[] } } }
    const run = release.jobs.release.steps.find(step => step.env?.CI_CHECK != null)?.run ?? ''
    const body = /-e '([\s\S]*)'\s*$/.exec(run)?.[1] ?? ''
    const port = /^\s*import \{ execGh, readGhJson \} from "[^"]+"\s*$/m
    expect(body, 'the wait step names its script inline and imports the GitHub port').toMatch(port)
    return body.replace(port, '')
  }

  async function runWait(polls: CheckRun[][]): Promise<WaitOutcome> {
    let now = 0
    let calls = 0
    const gh: GhCaller = () => {
      calls += 1
      if (calls > POLL_CAP)
        throw new Error('still waiting')
      return { kind: 'ran', stdout: JSON.stringify({ check_runs: polls[Math.min(calls, polls.length) - 1] }), attempts: 1 }
    }
    const proc = {
      env: { SHA: 'abc123', CI_CHECK: 'required', GITHUB_REPOSITORY: 'o/r', CI_WAIT_SECONDS: String(WAIT_SECONDS) },
      exit: (code: number) => {
        throw Object.assign(new Error('exit'), { code })
      },
    }
    const clock = { now: () => now }
    const sleep = (resolve: () => void, ms: number) => {
      now += ms
      resolve()
    }
    const body = new AsyncFunction('execGh', 'readGhJson', 'process', 'Date', 'setTimeout', 'console', waitScript())
    try {
      await body(gh, readGhJson, proc, clock, sleep, { log: () => {} })
    }
    catch (error) {
      if (error instanceof Error && 'code' in error)
        return { exit: error.code as number, polls: calls }
      if (error instanceof Error && error.message === 'still waiting')
        return { exit: 'still waiting', polls: POLL_CAP }
      throw error
    }
    return { exit: 'still waiting', polls: calls }
  }

  it('passes on the first poll that reads a successful check', async () => {
    expect(await runWait([[{ id: 1, status: 'completed', conclusion: 'success', app: ACTIONS }]])).toEqual({ exit: 0, polls: 1 })
  })

  it('stops the job at once when the check completed with any conclusion other than success', async () => {
    for (const conclusion of ['failure', 'cancelled', 'timed_out'])
      expect(await runWait([[{ id: 1, status: 'completed', conclusion, app: ACTIONS }]]), conclusion).toEqual({ exit: 1, polls: 1 })
  })

  it('stops the job at the deadline when the check never completes, instead of waiting forever', async () => {
    const outcome = await runWait([[{ id: 1, status: 'in_progress', conclusion: null, app: ACTIONS }]])
    expect(outcome.exit).toBe(1)
    expect(outcome.polls).toBeLessThanOrEqual(WAIT_SECONDS / 30 + 1)
  })

  it('stops the job at the deadline when no check run appears on the commit', async () => {
    expect((await runWait([[]])).exit).toBe(1)
  })

  it('judges the latest GitHub Actions run, not another app\'s run or an older run listed last', async () => {
    const runs = [
      { id: 2, status: 'completed', conclusion: 'success', app: ACTIONS },
      { id: 9, status: 'completed', conclusion: 'failure', app: { slug: 'another-app' } },
      { id: 1, status: 'completed', conclusion: 'failure', app: ACTIONS },
    ]
    expect(await runWait([runs])).toEqual({ exit: 0, polls: 1 })
    expect(await runWait([[...runs, { id: 3, status: 'completed', conclusion: 'failure', app: ACTIONS }]])).toEqual({ exit: 1, polls: 1 })
  })

  it('keeps polling while the latest run is in progress and follows it to its conclusion', async () => {
    const pending = { id: 4, status: 'in_progress', conclusion: null, app: ACTIONS }
    const done = { ...pending, status: 'completed', conclusion: 'success' }
    expect(await runWait([[pending], [pending], [done]])).toEqual({ exit: 0, polls: 3 })
  })
})

describe('a version whose record turned out to be wrong is answered, not corrected', () => {
  const notices = parseNotices(parseChangelog(CHANGELOG))

  it('finds a notice in the changelog at all, so an empty set cannot pass for a pairing that holds', () => {
    expect(notices.length).toBeGreaterThan(1)
    for (const notice of notices)
      expect(notice.recorded, notice.version).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('names only versions the changelog carries, so a notice cannot point at nothing', () => {
    const versions = parseChangelog(CHANGELOG).map(entry => entry.version)
    for (const notice of notices) {
      expect(notice.names, notice.version).not.toEqual([])
      for (const named of notice.names)
        expect(versions, `${notice.version} names ${named}`).toContain(named)
    }
  })

  it('answers every notice from the version it names, because a reader arrives at the version they installed', () => {
    expect(unansweredNotices(notices)).toEqual([])
  })

  it('goes red for a notice pointing one way only, which is the shape that leaves half the readers unserved', () => {
    const pointing = { version: '9.9.0', recorded: '2026-01-01', body: '', names: ['9.9.1'] }
    const silent = { version: '9.9.1', recorded: '2026-01-01', body: '', names: [] }

    expect(unansweredNotices([pointing, silent])).toEqual(['9.9.0 → 9.9.1'])
    expect(unansweredNotices([pointing, { ...silent, names: ['9.9.0'] }])).toEqual([])
  })

  it('reads a version out of a notice by its whole number, so 0.9.1 is not found inside 0.9.10', () => {
    const named = parseNotices([
      { version: '0.10.0', body: '> **Recorded 2026-01-01 — a.** The changes below reached the registry in 0.9.10.' },
      { version: '0.9.10', body: '' },
      { version: '0.9.1', body: '' },
    ])[0].names

    expect(named).toEqual(['0.9.10'])
    expect(named).not.toContain('0.9.1')
  })

  it('carries each notice onto the page rendered from the changelog, not only into the changelog', () => {
    const rendered = renderIndex(parseChangelog(CHANGELOG), handWrittenNotes())
    for (const notice of notices)
      expect(rendered, notice.version).toContain(notice.body)
  })
})
