import { appendFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { MorseRefusal } from './rules.js'

function realDirectoryOf(journalPath: string): string {
  const directory = path.dirname(path.resolve(journalPath))
  try {
    return realpathSync(directory)
  }
  catch {
    return directory
  }
}

export function refuseJournalInside(journalPath: string, repositories: string[]): void {
  const directory = realDirectoryOf(journalPath)
  for (const repository of repositories) {
    const relative = path.relative(realpathSync(repository), directory)
    const outside = relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)
    if (!outside)
      throw new MorseRefusal(`the journal ${journalPath} is inside the repository ${repository}`)
  }
}

export function appendJournalLine(journalPath: string, line: string): void {
  appendFileSync(journalPath, `${line}\n`)
}
