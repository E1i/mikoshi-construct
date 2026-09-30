const SHELL_SAFE_WORD = /^[\w./@:=-]+$/

export function shellWord(word: string): string {
  return SHELL_SAFE_WORD.test(word) ? word : `'${word.replaceAll('\'', `'\\''`)}'`
}
