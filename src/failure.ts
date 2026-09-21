import type { Ui } from './ui/console.js'
import { ManifestAheadOfReader } from './manifest.js'

export function flatlineFor(ui: Ui, error: unknown): void {
  if (error instanceof ManifestAheadOfReader)
    ui.flatline(ui.lore.manifestAhead(error.found, error.understood))
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
