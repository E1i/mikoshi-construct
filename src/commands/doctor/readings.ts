import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

function cause(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class FileReadings {
  private readonly causes = new Map<string, string>()

  constructor(private readonly root: string) {}

  read(file: string): string | null {
    const target = path.join(this.root, file)
    if (!existsSync(target))
      return null
    try {
      return readFileSync(target, 'utf8')
    }
    catch (error) {
      this.causes.set(file, cause(error))
      return null
    }
  }

  readJson(file: string): Record<string, unknown> | null {
    const source = this.read(file)
    if (source == null)
      return null
    try {
      return JSON.parse(source) as Record<string, unknown>
    }
    catch (error) {
      this.causes.set(file, cause(error))
      return null
    }
  }

  entries(directory: string): string[] | null {
    const target = path.join(this.root, directory)
    if (!existsSync(target))
      return null
    try {
      return readdirSync(target)
    }
    catch (error) {
      this.causes.set(directory, cause(error))
      return null
    }
  }

  unreadable(file: string): boolean {
    return this.causes.has(file)
  }

  get files(): string[] {
    return [...this.causes.keys()].sort().map(file => `${file} (${this.causes.get(file) ?? ''})`)
  }
}
