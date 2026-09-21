import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import config from '../docs/.vitepress/config.js'
import { CHANGELOG_PATH, handWrittenNotes, INDEX_PATH, parseChangelog, releaseAnchor } from '../scripts/release-notes/changelog.js'
import { renderIndex } from '../scripts/release-notes/render.js'

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

  function scripts(): Record<string, string> {
    return (JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts
  }

  function resolved(name: string, table: Record<string, string>, seen = new Set<string>()): string {
    if (seen.has(name))
      return ''
    seen.add(name)
    const body = table[name] ?? ''
    return [body, ...[...body.matchAll(/pnpm (?:run )?([\w:-]+)/g)].map(match => resolved(match[1], table, seen))].join(' ')
  }

  function versionScript(): string {
    const workflow = readFileSync(path.join(REPO_ROOT, '.github/workflows/release.yml'), 'utf8')
    return /version-script:\s*pnpm (?:run )?([\w:-]+)/.exec(workflow)?.[1] ?? ''
  }

  it('names a version script the release workflow actually runs', () => {
    expect(versionScript()).not.toBe('')
    expect(scripts()[versionScript()]).toBeDefined()
  })

  it('reaches the renderer from that script, so a release cannot bump the changelog and leave the page behind', () => {
    expect(resolved(versionScript(), scripts())).toContain(RENDERER)
  })

  it('goes red when the version script stops reaching the renderer, which is how every release turned red before', () => {
    const withoutRender = { ...scripts(), [versionScript()]: 'changeset version' }
    expect(resolved(versionScript(), withoutRender)).not.toContain(RENDERER)
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

  it('keeps every hand-written note named, because it is the better artifact where it exists', () => {
    for (const version of handWrittenNotes().keys())
      expect(sublist().map(item => item.link), version).toContain(`/release-notes/${version}`)
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
