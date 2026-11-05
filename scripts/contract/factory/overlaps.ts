import type { Concept } from './concepts.js'
import { CONCEPTS, isOwnedBy } from './concepts.js'
import { eachNode, parsedFiles } from './walk.js'

export interface Site {
  concept: string
  file: string
  line: number
  form: string
}

export function findSites(root: string, concepts: readonly Concept[] = CONCEPTS): Site[] {
  return parsedFiles(root).flatMap(({ file, source }) => {
    const reading = concepts.filter(concept => !isOwnedBy(concept, file))
    const sites: Site[] = []
    eachNode(source, (node) => {
      for (const concept of reading) {
        for (const detector of concept.detectors) {
          const form = detector(node, file)
          if (form !== null)
            sites.push({ concept: concept.id, file, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, form })
        }
      }
    })
    return sites
  })
}

export function overlapsSection(sites: readonly Site[], concepts: readonly Concept[] = CONCEPTS): Record<string, Record<string, number>> {
  const section: Record<string, Record<string, number>> = Object.fromEntries(concepts.map(concept => [concept.id, {}]))
  for (const { concept, file } of sites)
    section[concept]![file] = (section[concept]![file] ?? 0) + 1
  return section
}

export function siteLine(site: Site): string {
  return `${site.file}:${site.line} ${site.concept} ${site.form}`
}
