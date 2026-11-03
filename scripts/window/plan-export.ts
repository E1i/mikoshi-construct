import type { DatabaseSync } from 'node:sqlite'
import { cardContract } from '../intake/card-contract.js'

export interface ExportSection {
  heading: string
  cards: readonly number[]
}

export interface ExportedRelease {
  title: string
  goal: string
  line: string
  sections: readonly ExportSection[]
}

function cardItem(db: DatabaseSync, card: number): string {
  const name = cardContract(db, card)?.name
  return `- #${card}${name === undefined ? '' : ` ${name}`}`
}

function sectionLines(db: DatabaseSync, section: ExportSection): string[] {
  return section.cards.length === 0 ? [] : ['', `## ${section.heading} (${section.cards.length})`, '', ...section.cards.map(card => cardItem(db, card))]
}

export function planMarkdown(db: DatabaseSync, release: ExportedRelease): string {
  return [`# ${release.title}`, '', release.goal, '', release.line, ...release.sections.flatMap(section => sectionLines(db, section)), ''].join('\n')
}
