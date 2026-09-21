import type { Ui } from './ui/console.js'
import { RecordAheadOfReader } from './record-ahead.js'

export function flatlineFor(ui: Ui, error: unknown): void {
  if (error instanceof RecordAheadOfReader)
    ui.flatline(ui.lore.recordAhead(error.record, error.field, error.found, error.understood))
  else
    ui.flatline(error instanceof Error ? error.message : String(error))
}

export function reported(ui: Ui, run: () => void): number {
  try {
    run()
    return 0
  }
  catch (error) {
    flatlineFor(ui, error)
    return 1
  }
}
