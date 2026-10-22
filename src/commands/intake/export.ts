import type { Ui } from '../../ui/console.js'
import type { CardAdmissionsPort } from './index.js'
import { INTAKE_EXIT } from './index.js'
import { CARD_NUMBER } from './move.js'

export interface ExportOptions {
  card: string
  admissions: CardAdmissionsPort
}

type ExportRefusal = 'notACard' | 'notAdmitted'

export type ExportResult
  = | { status: 'refused', refusal: ExportRefusal, card: string }
    | { status: 'exported', text: string }

const REFUSAL_REASON: Record<ExportRefusal, (card: string) => string> = {
  notACard: card => `--export ${card} names no card; give #<id>`,
  notAdmitted: card => `the bus holds no admitted text for ${card}`,
}

export function runExport(options: ExportOptions): ExportResult {
  const id = CARD_NUMBER.exec(options.card)?.[1]
  if (id === undefined)
    return { status: 'refused', refusal: 'notACard', card: options.card }
  const text = options.admissions(Number(id))?.text
  return text === undefined ? { status: 'refused', refusal: 'notAdmitted', card: `#${id}` } : { status: 'exported', text }
}

export function printExport(ui: Ui, result: ExportResult, write: (text: string) => void): number {
  if (result.status === 'refused') {
    ui.flatline(ui.lore.intakeRefusedUnreadable(REFUSAL_REASON[result.refusal](result.card)))
    return INTAKE_EXIT.refused
  }
  write(result.text)
  return INTAKE_EXIT.written
}
