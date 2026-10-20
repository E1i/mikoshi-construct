import type { MapComponent, MapContour } from './components.js'
import type { SourceLinks } from './source-link.js'
import type { AtlasMode } from './switch.js'
import type { AtlasInput, AtlasLink, AtlasNode, AtlasStage } from './view.js'
import { escaped } from '../model/page.js'
import { STATE_LEGEND } from '../model/svg.js'
import { componentMap } from './components.js'
import { DOCS_STYLE } from './docs-style.js'
import { sourceHref } from './page.js'
import { RELATIVE_LINKS } from './source-link.js'
import { switchHtml } from './switch.js'
import { folderTree } from './tree.js'
import { atlasOf } from './view.js'
import { abilityWords } from './words.js'

const DISCOVER_COMMAND = '/construct-discover'

const WORDS = {
  title: (project: string) => `${project}, read in order`,
  prose: 'The same Engram as the map, read from the first stage to the last. Each part says what it does, what holds it up and where its code lies; the explanation is this page’s, the facts are the document’s.',
  summary: (parts: number, bound: number, total: number) => `${parts} ${parts === 1 ? 'part' : 'parts'} · ${bound} of ${total} files bound to a part (${total === 0 ? 0 : Math.round(bound * 100 / total)}%) · ${total - bound} not bound`,
  fromMechanics: `No part is named in the Engram yet, so these parts are the packages and directories the code itself declares. ${DISCOVER_COMMAND} splits the code into parts in its interpretation step; its parts replace these.`,
  noModel: (name: string) => `${name} holds no part and no mechanics yet, so there is nothing to read in order. Run ${DISCOVER_COMMAND} to start the model.`,
  contents: 'Contents',
  emptyStage: 'Nothing found in this stage.',
  does: 'What it does',
  notDescribed: `Not described yet: ${DISCOVER_COMMAND} names what it does.`,
  notInterpreted: `Not interpreted yet: grouped by directory until ${DISCOVER_COMMAND} names it.`,
  evidence: 'It stands on',
  noEvidence: 'No fact is named under it.',
  leadsFrom: 'Comes from',
  leadsTo: 'Leads to',
  reaches: 'Reaches',
  code: (count: number) => `Code under it (${count} ${count === 1 ? 'file' : 'files'})`,
  source: 'Source',
  unclaimed: 'Code no part claims',
  bind: `How to bind it: run ${DISCOVER_COMMAND}; its interpretation step names the parts and the code under each.`,
  footer: (name: string) => `Every state is derived on read, never stored. Rendered from ${name}; nothing here is fetched when you open it.`,
}

interface DocsPart {
  anchor: string
  label: string
}

interface DocsSection {
  anchor: string
  label: string
  parts: DocsPart[]
}

interface DocsBody {
  sections: DocsSection[]
  summary: string
  html: string
}

function stageAnchor(index: number): string {
  return `stage-${index + 1}`
}

function linkList(heading: string, entries: AtlasLink[]): string {
  if (entries.length === 0)
    return ''
  return `<p>${escaped(heading)}: ${entries.map(entry => `<a href="#${escaped(entry.anchor)}">${escaped(entry.label)}</a>`).join(', ')}</p>`
}

function codeOf(files: string[]): string {
  return files.length === 0 ? '' : `<details><summary>${escaped(WORDS.code(files.length))}</summary>${folderTree(files)}</details>`
}

function does(line: string): string {
  return `<p class="does"><b>${escaped(WORDS.does)}:</b> ${escaped(line)}</p>`
}

function purposeOf(node: AtlasNode, input: AtlasInput): string {
  const under = new Set(node.components)
  const purposes = (input.model.interpretation?.components ?? []).filter(entry => entry.files.some(file => under.has(file))).map(entry => entry.purpose)
  return purposes.length === 0 ? WORDS.notDescribed : [...new Set(purposes)].join(' ')
}

function nodeSection(node: AtlasNode, input: AtlasInput, rootFromPage: string, links: SourceLinks): string {
  const evidence = node.evidence.length === 0
    ? `<p class="empty">${escaped(WORDS.noEvidence)}</p>`
    : `<p>${escaped(WORDS.evidence)}:</p><ul>${node.evidence.map(entry => `<li data-state="${entry.state}">${escaped(entry.subject)} — ${escaped(entry.word)}</li>`).join('')}</ul>`
  return [
    `<article id="${escaped(node.anchor)}" data-state="${node.state}">`,
    `<h3>${escaped(node.label)}</h3>`,
    does(purposeOf(node, input)),
    `<p class="state">${node.state} — ${escaped(STATE_LEGEND[node.state])}</p>`,
    `<p class="status">${escaped(abilityWords(node.ability))}</p>`,
    evidence,
    linkList(WORDS.leadsFrom, node.leadsFrom),
    linkList(WORDS.leadsTo, node.leadsTo),
    `<p><a href="${sourceHref(node.sourcePath, rootFromPage, links)}" data-source>${escaped(WORDS.source)}: ${escaped(node.sourcePath)}</a></p>`,
    codeOf(node.components),
    `</article>`,
  ].filter(part => part !== '').join('\n')
}

function stageSection(stage: AtlasStage, index: number, input: AtlasInput, rootFromPage: string, links: SourceLinks): string {
  return [
    `<section id="${stageAnchor(index)}" data-stage="${escaped(stage.id)}">`,
    `<h2>${escaped(stage.label)}</h2>`,
    stage.nodes.length === 0 ? `<p class="empty">${escaped(WORDS.emptyStage)}</p>` : stage.nodes.map(node => nodeSection(node, input, rootFromPage, links)).join('\n'),
    `</section>`,
  ].join('\n')
}

function engramBody(input: AtlasInput, rootFromPage: string, links: SourceLinks): DocsBody {
  const atlas = atlasOf(input)
  const total = input.mechanics?.components.length ?? 0
  const unclaimed = atlas.unclaimed.length === 0
    ? ''
    : `<section id="unclaimed" data-layer="mechanics"><h2>${escaped(WORDS.unclaimed)} (${atlas.unclaimed.length})</h2><p>${escaped(WORDS.bind)}</p>${folderTree(atlas.unclaimed)}</section>`
  return {
    sections: [
      ...atlas.stages.map((stage, index) => ({ anchor: stageAnchor(index), label: stage.label, parts: stage.nodes })),
      ...unclaimed === '' ? [] : [{ anchor: 'unclaimed', label: WORDS.unclaimed, parts: [] }],
    ],
    summary: WORDS.summary(input.model.nodes.length, total - atlas.unclaimed.length, total),
    html: [...atlas.stages.map((stage, index) => stageSection(stage, index, input, rootFromPage, links)), unclaimed].join('\n'),
  }
}

function partAnchor(id: string): string {
  return `part-${id.replaceAll(/[^\w.-]/g, '_')}`
}

function partSection(component: MapComponent, reaches: AtlasLink[]): string {
  const files = component.files.filter(file => file.state !== 'absent').map(file => file.path)
  return [
    `<article id="${escaped(partAnchor(component.id))}" data-state="${component.state}">`,
    `<h3>${escaped(component.name)}</h3>`,
    does(component.purpose ?? WORDS.notInterpreted),
    linkList(WORDS.reaches, reaches),
    codeOf(files),
    `</article>`,
  ].filter(part => part !== '').join('\n')
}

function contourSection(contour: MapContour, reachesOf: (id: string) => AtlasLink[]): string {
  return [
    `<section id="${escaped(partAnchor(contour.id))}" data-contour="${escaped(contour.id)}">`,
    `<h2>${escaped(contour.name)}</h2>`,
    contour.components.map(component => partSection(component, reachesOf(component.id))).join('\n'),
    `</section>`,
  ].join('\n')
}

function mechanicsBody(input: AtlasInput, mechanics: NonNullable<AtlasInput['mechanics']>): DocsBody {
  const map = componentMap({ contours: [], ...mechanics }, input.model.interpretation?.components ?? [], input.projectName)
  const contours = map.contours.filter(contour => contour.components.length > 0)
  const components = contours.flatMap(contour => contour.components)
  const nameOf = new Map(components.map(component => [component.id, component.name]))
  const reachesOf = (id: string): AtlasLink[] => map.arrows
    .filter(arrow => arrow.from === id && nameOf.has(arrow.to))
    .map(arrow => ({ anchor: partAnchor(arrow.to), label: nameOf.get(arrow.to)! }))
  const bound = new Set(components.flatMap(component => component.files.filter(file => file.state !== 'absent').map(file => file.path)))
  return {
    sections: contours.map(contour => ({ anchor: partAnchor(contour.id), label: contour.name, parts: contour.components.map(component => ({ anchor: partAnchor(component.id), label: component.name })) })),
    summary: WORDS.summary(components.length, bound.size, mechanics.components.length),
    html: [`<p class="prose">${escaped(WORDS.fromMechanics)}</p>`, ...contours.map(contour => contourSection(contour, reachesOf))].join('\n'),
  }
}

function docsBody(input: AtlasInput, generatedFrom: string, rootFromPage: string): DocsBody {
  const links = input.links ?? RELATIVE_LINKS
  if (input.model.nodes.length > 0)
    return engramBody(input, rootFromPage, links)
  if (input.mechanics != null && input.mechanics.components.length > 0)
    return mechanicsBody(input, input.mechanics)
  return { sections: [], summary: '', html: `<p class="empty" data-no-model>${escaped(WORDS.noModel(generatedFrom))}</p>` }
}

function contents(sections: DocsSection[]): string {
  return `<nav class="toc"><b>${escaped(WORDS.contents)}</b>${sections.map(section => `<ul><li><b><a href="#${escaped(section.anchor)}">${escaped(section.label)}</a></b></li>${section.parts.map(part => `<li><a href="#${escaped(part.anchor)}">${escaped(part.label)}</a></li>`).join('')}</ul>`).join('')}</nav>`
}

export function renderAtlasDocs(input: AtlasInput, generatedFrom: string, rootFromPage: string, modeFiles: Record<AtlasMode, string>): string {
  const body = docsBody(input, generatedFrom, rootFromPage)
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
${contents(body.sections)}
<main>
${switchHtml('docs', modeFiles)}
<h1>${escaped(WORDS.title(input.projectName))}</h1>
${body.summary === '' ? '' : `<p class="summary">${escaped(body.summary)}</p>`}
<p class="prose">${escaped(WORDS.prose)}</p>
${body.html}
<footer>${escaped(WORDS.footer(generatedFrom))}</footer>
</main>
</div>
</body>
</html>
`
}
