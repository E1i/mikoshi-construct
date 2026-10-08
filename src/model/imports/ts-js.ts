import type { ImportReader } from './reader.js'
import { scanModule } from '../scan.js'

const EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']

export const tsJsReader: ImportReader = {
  recognises: file => EXTENSIONS.some(extension => file.endsWith(extension)),
  read: scanModule,
}
