import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const README = readFileSync(path.join(REPO_ROOT, 'README.md'), 'utf8')
const SITE = 'https://e1i.github.io/mikoshi-construct/'

function linkedPages(): string[] {
  return [...README.matchAll(/https:\/\/e1i\.github\.io\/mikoshi-construct\/(\S*?)(?=[)\s])/g)].map(match => match[1])
}

function sourceOf(page: string): string {
  return path.join(REPO_ROOT, 'docs', page === '' ? 'index.md' : `${page}.md`)
}

describe('every documentation link the README ships', () => {
  it('points at a page this repository builds, because the README travels to npm where nothing checks it', () => {
    const pages = linkedPages()
    expect(pages.length).toBeGreaterThan(0)
    for (const page of pages)
      expect(existsSync(sourceOf(page)), `${SITE}${page} has no source at docs/`).toBe(true)
  })

  it('names the documentation before the install snippet, where a reader on npm sees it', () => {
    const docs = README.indexOf(`](${SITE})`)
    const install = README.indexOf('```bash')
    expect(docs).toBeGreaterThan(-1)
    expect(docs).toBeLessThan(install)
  })
})
