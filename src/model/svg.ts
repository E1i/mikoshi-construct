import type { PictureClass } from './graph.js'

export const LINE_HEIGHT = 18

export const STATE_LEGEND: Record<PictureClass, string> = {
  'held': 'every fact named under it was read and holds',
  'unsupported': 'every fact was read and at least one does not hold',
  'unknown': 'no fact is named, or a named fact could not be read',
  'runtime-report': 'stands on a runner’s report, which doctor reads at run time and the picture never reads',
}
