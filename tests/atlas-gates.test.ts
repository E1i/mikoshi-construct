import type { AtlasBuild } from '../scripts/atlas/gates.js'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildAtlas, copyFixture } from '../scripts/atlas/build.js'
import { atlasProblems, divergence, nodesWithoutSource, unresolvedLinks } from '../scripts/atlas/gates.js'
import { MODEL_FILE } from '../src/model/schema.js'

function built(spoil: (root: string) => void = () => {}): AtlasBuild {
  const root = copyFixture()
  spoil(root)
  return buildAtlas(root)
}

function editModel(root: string, edit: (model: Record<string, any>) => void): void {
  const file = path.join(root, MODEL_FILE)
  const model = JSON.parse(readFileSync(file, 'utf8')) as Record<string, any>
  edit(model)
  writeFileSync(file, `${JSON.stringify(model, null, 2)}\n`)
}

describe('the Atlas quality gates', () => {
  it('the fixture repository builds an Atlas every gate passes', () => {
    const build = built()
    expect(build.map.html).toContain('Press apples')
    expect(build.docs.html).toContain('Press apples')
    expect(atlasProblems(build)).toEqual([])
  })

  describe('every node link and source link resolves', () => {
    it('a node link to an anchor no element carries is red', () => {
      const { map } = built()
      const spoiled = { ...map, html: map.html.replace('href="#cellar"', 'href="#cellar-gone"') }
      expect(unresolvedLinks(spoiled)).toEqual([`${map.file}: #cellar-gone points at no element on the page`])
    })

    it('a source link to a path that does not exist is red', () => {
      const { docs } = built()
      const spoiled = { ...docs, html: docs.html.replace('src/press" data-source', 'src/pressed" data-source') }
      expect(unresolvedLinks(spoiled)).toEqual([`${docs.file}: ../src/pressed resolves to nothing on disk`])
    })

    it('the switch to the other view is a link it checks too', () => {
      const { map } = built()
      const spoiled = { ...map, html: map.html.replace('href="atlas-docs.html"', 'href="atlas-doc.html"') }
      expect(unresolvedLinks(spoiled)).toEqual([`${map.file}: atlas-doc.html resolves to nothing on disk`])
    })

    it('a broken href in the page markup turns the gate red while the script body is skipped', () => {
      const { map } = built()
      const script = /<script>([\s\S]*?)<\/script>/.exec(map.html)![1]!
      expect(script).toMatch(/href="/)
      expect(unresolvedLinks(map)).toEqual([])
      const before = { ...map, html: map.html.replace('href="#cellar"', 'href="#cellar-gone"') }
      const after = { ...map, html: map.html.replace('</script>', '</script><a href="cellar-gone.html">gone</a>') }
      expect(unresolvedLinks(before)).toEqual([`${map.file}: #cellar-gone points at no element on the page`])
      expect(unresolvedLinks(after)).toEqual([`${map.file}: cellar-gone.html resolves to nothing on disk`])
    })
  })

  describe('the docs view and the map do not diverge', () => {
    it('a node the docs view drops is red', () => {
      const { map, docs } = built()
      const spoiled = { ...docs, html: docs.html.replace(/<article id="cellar"[\s\S]*?<\/article>/, '') }
      expect(divergence(map, spoiled)).toEqual([`${docs.file} is missing node cellar that ${map.file} draws in stage keep`])
    })

    it('a node whose state, source or links differ between the views is red', () => {
      const { map, docs } = built()
      const spoiled = { ...docs, html: docs.html.replace(/<article id="press-apples" data-state="\w+">/, '<article id="press-apples" data-state="refuted">') }
      expect(divergence(map, spoiled)).toEqual([expect.stringMatching(/^node press-apples reads .+ in .+atlas\.html and .+refuted.+ in .+atlas-docs\.html$/)])
    })

    it('a node drawn under another stage is red', () => {
      const { map, docs } = built()
      const spoiled = { ...docs, html: docs.html.replace('data-stage="sell"', 'data-stage="sold"') }
      expect(divergence(map, spoiled)).toEqual([`${map.file} draws stage sell that ${docs.file} does not`, `${docs.file} draws stage sold that ${map.file} does not`])
    })
  })

  describe('a node without a source breaks the build', () => {
    it('a node whose source path does not exist is red', () => {
      const build = built(root => editModel(root, (model) => {
        model.nodes[0].source = { path: 'src/mill' }
      }))
      expect(nodesWithoutSource(build.model, build.root)).toEqual(['node press-apples: its source src/mill does not exist in the repository'])
      expect(atlasProblems(build)).toContain('node press-apples: its source src/mill does not exist in the repository')
    })

    it('a node whose source fact names a path that does not exist is red', () => {
      const build = built(root => editModel(root, (model) => {
        model.facts[2].path = 'src/cellar/barrel.ts'
      }))
      expect(nodesWithoutSource(build.model, build.root)).toEqual(['node cellar: its source src/cellar/barrel.ts does not exist in the repository'])
    })
  })
})
