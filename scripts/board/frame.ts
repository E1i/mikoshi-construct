import { renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { stripVTControlCharacters } from 'node:util'

export const FRAME_FILE = 'board.txt'
export const CLEAR_SCREEN = '\u001B[2J\u001B[3J\u001B[H'

export function frameFileIn(dir: string): string {
  return path.join(dir, FRAME_FILE)
}

export function frameText(lines: string[], clear: boolean): string {
  return `${clear ? CLEAR_SCREEN : ''}${lines.join('\n')}\n`
}

export function writeFrameFile(file: string, lines: string[]): void {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`)
  writeFileSync(temporary, frameText(lines.map(line => stripVTControlCharacters(line)), false))
  renameSync(temporary, file)
}
