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

interface DrawnNode {
  id: string
  stage: string
  reading: string
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

function drawnNodes(page: AtlasPage): DrawnNode[] {
  const sections = [...page.html.matchAll(/<section [^>]*data-stage="([^"]*)"[^>]*>([\s\S]*?)<\/section>/g)]
  return sections.flatMap(([, stage, body]) => [...body!.matchAll(/<article [^>]*id="([^"]*)" data-state="([^"]*)">([\s\S]*?)<\/article>/g)].map(([, id, state, article]) => {
    const links = attributes(article!, 'href').filter(href => href !== `#${id}`).sort()
    const evidence = [...article!.matchAll(/<li data-state="[^"]*">[^<]*<\/li>/g)].map(match => match[0])
    return { id: unescaped(id!), stage: unescaped(stage!), reading: JSON.stringify({ state, links, evidence }) }
  }))
}

function stagesOf(page: AtlasPage): string[] {
  return attributes(page.html, 'data-stage')
}

function missingStages(from: AtlasPage, other: AtlasPage): string[] {
  const drawn = new Set(stagesOf(other))
  return stagesOf(from).filter(stage => !drawn.has(stage)).map(stage => `${from.file} draws stage ${stage} that ${other.file} does not`)
}

function missingNodes(from: AtlasPage, other: AtlasPage): string[] {
  const drawn = new Set(drawnNodes(other).map(node => node.id))
  return drawnNodes(from).filter(node => !drawn.has(node.id)).map(node => `${other.file} is missing node ${node.id} that ${from.file} draws in stage ${node.stage}`)
}

export function divergence(map: AtlasPage, docs: AtlasPage): string[] {
  const stages = [...missingStages(map, docs), ...missingStages(docs, map)]
  if (stages.length > 0)
    return stages
  const inDocs = new Map(drawnNodes(docs).map(node => [node.id, node]))
  const differing = drawnNodes(map).flatMap((node) => {
    const twin = inDocs.get(node.id)
    if (twin == null)
      return []
    if (twin.stage !== node.stage)
      return [`node ${node.id} stands in stage ${node.stage} in ${map.file} and in stage ${twin.stage} in ${docs.file}`]
    return twin.reading === node.reading ? [] : [`node ${node.id} reads ${node.reading} in ${map.file} and ${twin.reading} in ${docs.file}`]
  })
  return [...missingNodes(map, docs), ...missingNodes(docs, map), ...differing]
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
    ...divergence(build.map, build.docs),
  ]
}
