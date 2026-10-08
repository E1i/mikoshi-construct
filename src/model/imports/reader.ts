import type { ModuleReading } from '../scan.js'

export interface ImportReader {
  recognises: (file: string) => boolean
  read: (source: string) => ModuleReading
}
