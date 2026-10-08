import type { ImportReader } from './reader.js'
import { sfcScriptReader } from './sfc-script.js'
import { tsJsReader } from './ts-js.js'

const IMPORT_READERS: ImportReader[] = [tsJsReader, sfcScriptReader]

export function importReaderFor(file: string): ImportReader | undefined {
  return IMPORT_READERS.find(reader => reader.recognises(file))
}
