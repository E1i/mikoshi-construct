import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export const PROMPTS_DIR = 'prompts'

export interface SessionInput {
  prompt: string
}

export interface AnswerInput extends SessionInput {
  cardBody: string | null
}

export type StoredInput = { prompt_sha: string, prompt_path: string } | { prompt_sha: string, prompt_unstored: string } | Record<string, never>

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

export function promptsDirOf(busPath: string): string {
  return path.join(path.dirname(busPath), PROMPTS_DIR)
}

export function storedInput(prompts: string | undefined, input: SessionInput | undefined): StoredInput {
  if (prompts === undefined || input === undefined)
    return {}
  const sha = sha256(input.prompt)
  const file = path.join(prompts, `${sha}.md`)
  try {
    mkdirSync(prompts, { recursive: true })
    writeFileSync(file, input.prompt)
    return { prompt_sha: sha, prompt_path: file }
  }
  catch (error) {
    return { prompt_sha: sha, prompt_unstored: error instanceof Error ? error.message : String(error) }
  }
}
