import type { PictureClass } from '../model/graph.js'
import type { AtlasMode } from './switch.js'
import type { Atlas, AtlasInput, AtlasLink, AtlasNode } from './view.js'
import { PICTURE_CLASSES } from '../model/graph.js'
import { escaped } from '../model/page.js'
import { STATE_LEGEND } from '../model/svg.js'
import { atlasScript, contentPolicy, mapSection } from './map.js'
import { ATLAS_STYLE } from './style.js'
import { switchHtml } from './switch.js'
import { atlasOf } from './view.js'
import { abilityWords } from './words.js'

const WORDS = {
  title: (project: string) => `What ${project} is made of, and what holds each part up`,
  prose: 'Each column is a stage this repository names for itself. Click a part to open it; a part nothing holds up is drawn as it is, not left out.',
  emptyStage: 'Nothing found in this stage.',
  evidence: 'What it stands on',
  noEvidence: 'No fact is named under it.',
  here: 'you are here',
  leadsFrom: '← comes from',
  leadsTo: 'leads to →',
  source: 'Open the source',
  footer: (name: string) => `Every state is derived on read, never stored. Rendered from ${name}; nothing here is fetched when you open it, and the page runs only the script written into it.`,
}

export function sourceHref(sourcePath: string, rootFromPage: string): string {
  const encoded = sourcePath.split('/').filter(segment => segment !== '').map(encodeURIComponent).join('/')
  return escaped(`${rootFromPage === '' ? '' : `${rootFromPage.split('/').map(encodeURIComponent).join('/')}/`}${encoded}`)
}

const indent = (text: string, spaces: number): string => text.split('\n').map(line => `${' '.repeat(spaces)}${line}`).join('\n')

function links(heading: string, entries: AtlasLink[]): string {
  if (entries.length === 0)
    return ''
  return `<details><summary>${escaped(heading)}</summary><ul>${entries.map(entry => `<li><a href="#${escaped(entry.anchor)}">${escaped(entry.label)}</a></li>`).join('')}</ul></details>`
}

function evidence(node: AtlasNode): string {
  const items = node.evidence.length === 0
    ? `<p class="empty">${escaped(WORDS.noEvidence)}</p>`
    : `<ul>${node.evidence.map(entry => `<li data-state="${entry.state}">${escaped(entry.subject)} — ${escaped(entry.word)}</li>`).join('')}</ul>`
  return `<details><summary>${escaped(WORDS.evidence)}</summary>${items}</details>`
}

function nodeHtml(node: AtlasNode, rootFromPage: string): string {
  return [
    `<li><article class="node" id="${escaped(node.anchor)}" data-state="${node.state}">`,
    `  <h3><a class="name" href="#${escaped(node.anchor)}">${escaped(node.label)}</a></h3>`,
    `  <p class="state">${node.state}</p>`,
    `  <p class="status">${escaped(abilityWords(node.ability))}</p>`,
    `  <div class="panel">`,
    `    <p class="here">${escaped(WORDS.here)}</p>`,
    indent([evidence(node), links(WORDS.leadsFrom, node.leadsFrom), links(WORDS.leadsTo, node.leadsTo), `<a href="${sourceHref(node.sourcePath, rootFromPage)}" data-source>${escaped(WORDS.source)}: ${escaped(node.sourcePath)}</a>`].filter(part => part !== '').join('\n'), 4),
    `  </div>`,
    `</article></li>`,
  ].join('\n')
}

function stagesHtml(atlas: Atlas, rootFromPage: string): string {
  return atlas.stages.map(stage => [
    `<section class="stage" data-stage="${escaped(stage.id)}">`,
    `  <h2>${escaped(stage.label)}</h2>`,
    stage.nodes.length === 0
      ? `  <p class="empty">${escaped(WORDS.emptyStage)}</p>`
      : `  <ul>\n${indent(stage.nodes.map(node => nodeHtml(node, rootFromPage)).join('\n'), 4)}\n  </ul>`,
    `</section>`,
  ].join('\n')).join('\n')
}

function legend(atlas: Atlas): string {
  const present = new Set<PictureClass>(atlas.stages.flatMap(stage => stage.nodes.map(node => node.state)))
  return PICTURE_CLASSES.filter(state => present.has(state)).map(state => `<li data-state="${state}"><b>${state}</b> — ${escaped(STATE_LEGEND[state])}</li>`).join('')
}

export function renderAtlas(input: AtlasInput, generatedFrom: string, rootFromPage = '', modeFiles?: Record<AtlasMode, string>): string {
  const atlas = atlasOf(input)
  const script = atlasScript(input, rootFromPage)
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${contentPolicy(script, ATLAS_STYLE)}">
<title>${escaped(WORDS.title(input.projectName))}</title>
<style>${ATLAS_STYLE}</style>
</head>
<body>
<main>
${modeFiles == null ? '' : switchHtml('map', modeFiles)}
<h1>${escaped(WORDS.title(input.projectName))}</h1>
${mapSection(script)}
<p class="prose">${escaped(WORDS.prose)}</p>
<div class="map">
${indent(stagesHtml(atlas, rootFromPage), 2)}
</div>
<ul class="legend">${legend(atlas)}</ul>
<footer>${escaped(WORDS.footer(generatedFrom))}</footer>
</main>
${script == null ? '' : `<script>${script}</script>\n`}</body>
</html>
`
}
