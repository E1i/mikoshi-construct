import { describe, expect, it } from 'vitest'
import { brokenFileLinks } from '../scripts/docs/file-links.js'

const BASE = '/mikoshi-construct/'
const BUILT = new Set(['atlas.html'])
const exists = (file: string) => BUILT.has(file)

describe('a built link to an .html file resolves to a file in the build, under the base once', () => {
  it('passes a link that names the base once and a file the build holds', () => {
    const pages = [{ page: 'atlas-guide.html', html: '<a href="/mikoshi-construct/atlas.html" target="_self">' }]

    expect(brokenFileLinks(pages, BASE, exists)).toEqual([])
  })

  it('names a link that carries the base twice', () => {
    const pages = [{ page: 'atlas-guide.html', html: '<a href="/mikoshi-construct/mikoshi-construct/atlas.html">' }]

    expect(brokenFileLinks(pages, BASE, exists)).toEqual([{ page: 'atlas-guide.html', href: '/mikoshi-construct/mikoshi-construct/atlas.html' }])
  })

  it('names a link without the base', () => {
    const pages = [{ page: 'atlas-guide.html', html: '<a href="/atlas.html">' }]

    expect(brokenFileLinks(pages, BASE, exists)).toEqual([{ page: 'atlas-guide.html', href: '/atlas.html' }])
  })

  it('names a link to a file the build does not hold', () => {
    const pages = [{ page: 'index.html', html: '<a href="/mikoshi-construct/missing.html">' }]

    expect(brokenFileLinks(pages, BASE, exists)).toEqual([{ page: 'index.html', href: '/mikoshi-construct/missing.html' }])
  })

  it('leaves a relative link alone', () => {
    const pages = [{ page: 'index.html', html: '<a href="other.html">' }]

    expect(brokenFileLinks(pages, BASE, exists)).toEqual([])
  })
})
