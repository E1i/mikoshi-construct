import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')

function read(file: string): string {
  return readFileSync(path.join(REPO_ROOT, file), 'utf8')
}

function readmeCommands(): string[] {
  return [...read('README.md').matchAll(/^\| `construct ([a-z-]+)` \|/gm)].map(match => match[1])
}

function sidebarGuides(): string[] {
  return [...read('docs/.vitepress/config.ts').matchAll(/link: '\/(guide\/[\w-]+)'/g)].map(match => `docs/${match[1]}.md`)
}

describe('every command on the front page has a guide a reader can reach', () => {
  const commands = readmeCommands()
  const guides = [...new Set(sidebarGuides())]

  it('reads the README command table and the guide sidebar', () => {
    expect(commands.length).toBeGreaterThan(3)
    expect(guides.length).toBeGreaterThan(3)
  })

  for (const command of commands) {
    it(`a guide in the sidebar names \`construct ${command}\`, not only the reference`, () => {
      const naming = guides.filter(guide => read(guide).includes(`construct ${command}`))
      expect(naming, `no page under docs/guide/ in the sidebar names construct ${command}`).not.toEqual([])
    })
  }
})
