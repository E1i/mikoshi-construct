import type { AtlasMode } from './switch.js'
import type { AtlasInput } from './view.js'
import { escaped } from '../model/page.js'
import { heroHtml, statusHtml, topbarHtml } from './chrome.js'
import { atlasScript, contentPolicy, mapOf, mapSection } from './map.js'
import { ATLAS_STYLE } from './style.js'
import { tallyOf } from './tally.js'
import { THEME_SCRIPT } from './theme.js'

const WORDS = {
  title: (project: string) => `Atlas · ${project}`,
}

export function renderAtlas(input: AtlasInput, generatedFrom: string, rootFromPage = '', modeFiles?: Record<AtlasMode, string>): string {
  const map = mapOf(input)
  const mapScript = atlasScript(input, rootFromPage, map)
  const script = `${THEME_SCRIPT}${mapScript ?? ''}`
  const tally = map == null || input.mechanics == null ? null : tallyOf(map, input.mechanics)
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta http-equiv="Content-Security-Policy" content="${contentPolicy(script, ATLAS_STYLE)}">
<title>${escaped(WORDS.title(input.projectName))}</title>
<style>${ATLAS_STYLE}</style>
</head>
<body>
${topbarHtml('map', modeFiles)}
<main class="page">
${heroHtml('map', input.projectName, tally)}
${mapSection(mapScript, generatedFrom)}
${statusHtml(generatedFrom)}
</main>
<script>${script}</script>
</body>
</html>
`
}
