import type { AtlasMode } from './switch.js'
import type { AtlasInput, AtlasLink, AtlasNode, AtlasStage } from './view.js'
import { escaped } from '../model/page.js'
import { STATE_LEGEND } from '../model/svg.js'
import { DOCS_STYLE } from './docs-style.js'
import { sourceHref } from './page.js'
import { switchHtml } from './switch.js'
import { atlasOf } from './view.js'

const WORDS = {
  title: (project: string) => `${project}, read in order`,
  prose: 'The same Engram as the map, read from the first stage to the last. Each part says what holds it up; the explanation is this page’s, the facts are the document’s.',
  contents: 'Contents',
  emptyStage: 'Nothing found in this stage.',
  evidence: 'It stands on',
  noEvidence: 'No fact is named under it.',
  leadsFrom: 'Comes from',
  leadsTo: 'Leads to',
  code: 'Code under it',
  source: 'Source',
  unclaimed: 'Code no part claims',
  footer: (name: string) => `Every state is derived on read, never stored. Rendered from ${name}; nothing here is fetched when you open it.`,
}

function stageAnchor(index: number): string {
  return `stage-${index + 1}`
}

function linkList(heading: string, entries: AtlasLink[]): string {
  if (entries.length === 0)
    return ''
  return `<p>${escaped(heading)}: ${entries.map(entry => `<a href="#${escaped(entry.anchor)}">${escaped(entry.label)}</a>`).join(', ')}</p>`
}

function nodeSection(node: AtlasNode, rootFromPage: string): string {
  const evidence = node.evidence.length === 0
    ? `<p class="empty">${escaped(WORDS.noEvidence)}</p>`
    : `<p>${escaped(WORDS.evidence)}:</p><ul>${node.evidence.map(entry => `<li data-state="${entry.state}">${escaped(entry.subject)} — ${escaped(entry.word)}</li>`).join('')}</ul>`
  const code = node.components.length === 0
    ? ''
    : `<p>${escaped(WORDS.code)}:</p><ul>${node.components.map(component => `<li>${escaped(component)}</li>`).join('')}</ul>`
  return [
    `<article id="${escaped(node.anchor)}" data-state="${node.state}">`,
    `<h3>${escaped(node.label)}</h3>`,
    `<p class="state">${node.state} — ${escaped(STATE_LEGEND[node.state])}</p>`,
    evidence,
    linkList(WORDS.leadsFrom, node.leadsFrom),
    linkList(WORDS.leadsTo, node.leadsTo),
    code,
    `<p><a href="${sourceHref(node.sourcePath, rootFromPage)}" data-source>${escaped(WORDS.source)}: ${escaped(node.sourcePath)}</a></p>`,
    `</article>`,
  ].filter(part => part !== '').join('\n')
}

function stageSection(stage: AtlasStage, index: number, rootFromPage: string): string {
  return [
    `<section id="${stageAnchor(index)}" data-stage="${escaped(stage.id)}">`,
    `<h2>${escaped(stage.label)}</h2>`,
    stage.nodes.length === 0 ? `<p class="empty">${escaped(WORDS.emptyStage)}</p>` : stage.nodes.map(node => nodeSection(node, rootFromPage)).join('\n'),
    `</section>`,
  ].join('\n')
}

function contents(stages: AtlasStage[]): string {
  return `<nav class="toc"><b>${escaped(WORDS.contents)}</b>${stages.map((stage, index) => `<ul><li><b><a href="#${stageAnchor(index)}">${escaped(stage.label)}</a></b></li>${stage.nodes.map(node => `<li><a href="#${escaped(node.anchor)}">${escaped(node.label)}</a></li>`).join('')}</ul>`).join('')}</nav>`
}

export function renderAtlasDocs(input: AtlasInput, generatedFrom: string, rootFromPage: string, modeFiles: Record<AtlasMode, string>): string {
  const atlas = atlasOf(input)
  const unclaimed = atlas.unclaimed.length === 0
    ? ''
    : `<section data-layer="mechanics"><h2>${escaped(WORDS.unclaimed)} (${atlas.unclaimed.length})</h2><ul>${atlas.unclaimed.map(entry => `<li>${escaped(entry)}</li>`).join('')}</ul></section>`
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escaped(WORDS.title(input.projectName))}</title>
<style>${DOCS_STYLE}</style>
</head>
<body>
<div class="layout">
${contents(atlas.stages)}
<main>
${switchHtml('docs', modeFiles)}
<h1>${escaped(WORDS.title(input.projectName))}</h1>
<p class="prose">${escaped(WORDS.prose)}</p>
${atlas.stages.map((stage, index) => stageSection(stage, index, rootFromPage)).join('\n')}
${unclaimed}
<footer>${escaped(WORDS.footer(generatedFrom))}</footer>
</main>
</div>
</body>
</html>
`
}
