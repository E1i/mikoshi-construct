import { defineConfig } from 'vitepress'
import { withMermaid } from 'vitepress-plugin-mermaid'
import { releaseSidebarItems } from '../../scripts/release-notes/changelog.js'

export default withMermaid(defineConfig({
  title: 'mikoshi-construct',
  description: 'Bootstrap for AI-native software projects: policy, contract, harness and agent instructions, materialized into a repository.',
  base: '/mikoshi-construct/',
  lastUpdated: true,
  cleanUrls: true,
  head: [['link', { rel: 'icon', href: '/mikoshi-construct/favicon.svg' }]],
  themeConfig: {
    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
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
