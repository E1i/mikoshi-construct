const TRAILING_COMMA = /,(\s*[}\]])/g

function stringEnd(text: string, start: number): number {
  let end = start + 1
  while (end < text.length && text[end] !== '"')
    end += text[end] === '\\' ? 2 : 1
  return end + 1
}

function withoutComments(text: string): string {
  let result = ''
  let index = 0
  while (index < text.length) {
    const current = text[index]
    if (current === '"') {
      const end = stringEnd(text, index)
      result += text.slice(index, end)
      index = end
    }
    else if (text.startsWith('//', index)) {
      const end = text.indexOf('\n', index)
      index = end === -1 ? text.length : end
    }
    else if (text.startsWith('/*', index)) {
      const end = text.indexOf('*/', index + 2)
      index = end === -1 ? text.length : end + 2
    }
    else {
      result += current
      index += 1
    }
  }
  return result
}

function withoutTrailingCommas(text: string): string {
  let result = ''
  let index = 0
  while (index < text.length) {
    if (text[index] === '"') {
      const end = stringEnd(text, index)
      result += text.slice(index, end)
      index = end
      continue
    }
    const next = text.indexOf('"', index)
    const stop = next === -1 ? text.length : next
    result += text.slice(index, stop).replace(TRAILING_COMMA, '$1')
    index = stop
  }
  return result
}

export function parseJsonc(text: string): unknown {
  try {
    return JSON.parse(withoutTrailingCommas(withoutComments(text)))
  }
  catch {
    return null
  }
}
