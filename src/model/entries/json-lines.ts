export function lineAtOffset(text: string, offset: number): number {
  let line = 1
  for (let index = 0; index < offset && index < text.length; index += 1) {
    if (text[index] === '\n')
      line += 1
  }
  return line
}

export function cursorOver(text: string): (needle: string) => number | null {
  let from = 0
  return (needle) => {
    const at = text.indexOf(needle, from)
    if (at === -1)
      return null
    from = at + needle.length
    return lineAtOffset(text, at)
  }
}
