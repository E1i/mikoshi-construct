import { copyFile } from 'node:fs/promises'
import path from 'node:path'
import { defineConfig } from 'vitepress'
import { withMermaid } from 'vitepress-plugin-mermaid'
import { releaseSidebarItems, REPO_ROOT } from '../../scripts/release-notes/changelog.js'

export default withMermaid(defineConfig({
  title: 'mikoshi-construct',
  description: 'Bootstrap for AI-native software projects: policy, contract, harness and agent instructions, materialized into a repository.',
  base: '/mikoshi-construct/',
  lastUpdated: true,
  cleanUrls: true,
  rewrites: { 'atlas.md': 'atlas-guide.md' },
  ignoreDeadLinks: [/^\/mikoshi-construct\/atlas$/],
  async buildEnd(siteConfig) {
    await copyFile(path.join(REPO_ROOT, '.construct/atlas.html'), path.join(siteConfig.outDir, 'atlas.html'))
  },
  head: [['link', { rel: 'icon', href: '/mikoshi-construct/favicon.svg' }]],
  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'Atlas', link: '/atlas-guide' },
      { text: 'CLI', link: '/cli' },
      { text: 'Releases', link: '/release-notes/' },
    ],
    sidebar: [
      {
        text: 'Guide',
        items: [
          { text: 'Getting started', link: '/guide/getting-started' },
          { text: 'The development cycle', link: '/guide/the-cycle' },
          { text: 'The reasoning budget', link: '/guide/reasoning-budget' },
          { text: 'Upgrading a repository', link: '/guide/upgrading' },
          { text: 'Working in a repository the construct did not write', link: '/guide/attach' },
          { text: 'What it refuses to claim', link: '/guide/what-it-refuses-to-claim' },
          { text: 'INIT', link: '/guide/init' },
          { text: 'HIJACK', link: '/guide/hijack' },
          { text: 'The factory and its two modes', link: '/guide/factory' },
          { text: 'Miko\'s window', link: '/guide/miko-window' },
          { text: 'The atlas', link: '/atlas-guide' },
        ],
      },
      {
        text: 'Architecture',
        items: [
          { text: 'Init', link: '/guide/architecture/init' },
          { text: 'Attach', link: '/guide/architecture/attach' },
          { text: 'Sync', link: '/guide/architecture/sync' },
          { text: 'Doctor', link: '/guide/architecture/doctor' },
          { text: 'Atlas', link: '/guide/architecture/atlas' },
        ],
      },
      {
        text: 'Reference',
        items: [
          { text: 'CLI', link: '/cli' },
        ],
      },
      {
        text: 'Releases',
        items: [
          { text: 'All releases', link: '/release-notes/' },
          ...releaseSidebarItems(),
        ],
      },
    ],
    socialLinks: [{ icon: 'github', link: 'https://github.com/E1i/mikoshi-construct' }],
    search: { provider: 'local' },
    editLink: {
      pattern: 'https://github.com/E1i/mikoshi-construct/edit/main/docs/:path',
      text: 'Edit this page on GitHub',
    },
    footer: {
      message: 'Names are a tribute to Cyberpunk 2077. Not affiliated with CD Projekt Red.',
      copyright: 'MIT licensed',
    },
  },
}))
