import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import config from '../../docs/.vitepress/config.js'
import { REPO_ROOT } from '../release-notes/changelog.js'

interface SidebarItem {
  link?: string
  items?: SidebarItem[]
}

const DIST = path.join(REPO_ROOT, 'docs/.vitepress/dist')

function links(items: SidebarItem[]): string[] {
  return items.flatMap(item => [...(item.link == null ? [] : [item.link]), ...links(item.items ?? [])])
}

function anchored(): { link: string, page: string, id: string }[] {
  const theme = config.themeConfig as { nav?: SidebarItem[], sidebar?: SidebarItem[] }
  return [...links(theme.nav ?? []), ...links(theme.sidebar ?? [])]
    .filter(link => link.includes('#'))
    .map((link) => {
      const [page, id] = link.split('#')
      return { link, page, id }
    })
}

function idsOn(page: string): string[] {
  const file = path.join(DIST, page.endsWith('/') ? `${page}index.html` : `${page}.html`)
  if (!existsSync(file))
    return []
  return [...readFileSync(file, 'utf8').matchAll(/<h[1-6] id="([^"]+)"/g)].map(match => match[1])
}

if (!existsSync(DIST)) {
  console.error('[docs:anchors] no build at docs/.vitepress/dist: run `pnpm docs:build` first, or this would check nothing')
  process.exit(1)
}

const targets = anchored()
if (targets.length === 0) {
  console.error('[docs:anchors] no anchored link found in the navigation: the check would pass over nothing')
  process.exit(1)
}

const broken = targets.filter(target => !idsOn(target.page).includes(target.id))
for (const target of broken)
  console.error(`[docs:anchors] ${target.link} — no heading with id "${target.id}" in the rendered ${target.page}`)

console.log(`[docs:anchors] ${targets.length - broken.length}/${targets.length} anchored links resolve to a rendered heading`)
process.exit(broken.length === 0 ? 0 : 1)
