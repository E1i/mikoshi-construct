import type { AbilityNode, Fact, RepositoryModel } from '../../src/model/schema.js'
import { existsSync } from 'node:fs'
import path from 'node:path'

export interface AtlasPage {
  file: string
  html: string
}

export interface AtlasBuild {
  root: string
  model: RepositoryModel
  map: AtlasPage
  docs: AtlasPage
}

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"' }

function unescaped(value: string): string {
  return value.replaceAll(/&(?:amp|lt|gt|quot);/g, entity => ENTITIES[entity]!)
}

function attributes(html: string, name: string): string[] {
  return [...html.matchAll(new RegExp(`\\s${name}="([^"]*)"`, 'g'))].map(match => unescaped(match[1]!))
}

function markupOf(html: string): string {
  return html.replaceAll(/(<script[^>]*>)[\s\S]*?(<\/script>)/g, '$1$2')
}

export function unresolvedLinks(page: AtlasPage): string[] {
  const markup = markupOf(page.html)
  const ids = new Set(attributes(markup, 'id'))
  return attributes(markup, 'href').flatMap((href) => {
    if (href.startsWith('#'))
      return ids.has(href.slice(1)) ? [] : [`${page.file}: ${href} points at no element on the page`]
    return existsSync(path.resolve(path.dirname(page.file), decodeURIComponent(href))) ? [] : [`${page.file}: ${href} resolves to nothing on disk`]
  })
}

function sourcePathOf(node: AbilityNode, facts: Fact[]): string {
  if ('path' in node.source)
    return node.source.path
  const { fact } = node.source
  return facts.find(candidate => candidate.id === fact)?.path ?? fact
}

export function nodesWithoutSource(model: RepositoryModel, root: string): string[] {
  return model.nodes.flatMap((node) => {
    const source = sourcePathOf(node, model.facts)
    return existsSync(path.join(root, source)) ? [] : [`node ${node.id}: its source ${source} does not exist in the repository`]
  })
}

export function atlasProblems(build: AtlasBuild): string[] {
  return [
    ...nodesWithoutSource(build.model, build.root),
    ...unresolvedLinks(build.map),
    ...unresolvedLinks(build.docs),
  ]
}
