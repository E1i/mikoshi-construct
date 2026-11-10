import type { LawCell, LawCells, LawId, LawSite } from '../../nodes/laws.js'
import type { Factory } from '../factory.js'
import { LAW_CELLS, LAW_SITES, lawIds, LAWS } from '../../nodes/laws.js'

export const LAWS_VERSION = 2

export interface LawRow {
  text: string
  cells: Record<LawSite, LawCell>
}

export interface LawsSection {
  lawsVersion: number
  laws: Record<LawId, LawRow>
}

export type FactoryWithLaws = Factory & { laws: LawsSection }

export function lawsSection(cells: LawCells = LAW_CELLS): LawsSection {
  return {
    lawsVersion: LAWS_VERSION,
    laws: Object.fromEntries(lawIds().map(law => [law, {
      text: LAWS[law],
      cells: Object.fromEntries(LAW_SITES.map(site => [site, cells[law][site]])) as Record<LawSite, LawCell>,
    }])) as Record<LawId, LawRow>,
  }
}

export function withLaws(factory: Factory): FactoryWithLaws {
  return { ...factory, laws: lawsSection() }
}
