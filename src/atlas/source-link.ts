export interface SourceLinks {
  template: string | null
  remote: string | null
}

export const RELATIVE_LINKS: SourceLinks = { template: null, remote: null }

export const EDITOR_PRESETS: Record<string, string> = {
  vscode: 'vscode://file/{abs}:{line}',
  cursor: 'cursor://file/{abs}:{line}',
  zed: 'zed://file/{abs}:{line}',
  idea: 'idea://open?file=/{abs}&line={line}',
}

const SCHEME = /^([a-z][\w+.-]*):/i
const REFUSED_SCHEMES = new Set(['javascript', 'data', 'vbscript', 'blob'])

export function editorTemplate(open: string | undefined): string | null {
  if (open == null)
    return null
  const template = EDITOR_PRESETS[open] ?? open
  const scheme = SCHEME.exec(template)?.[1]?.toLowerCase()
  return scheme == null || REFUSED_SCHEMES.has(scheme) || !template.includes('{abs}') ? null : template
}

function encodedPath(sourcePath: string): string {
  return sourcePath.split('/').filter(segment => segment !== '').map(encodeURIComponent).join('/')
}

export function staticSourceHref(sourcePath: string, rootFromPage: string, links: SourceLinks): string {
  if (links.remote != null)
    return `${links.remote}/${encodedPath(sourcePath)}`
  return `${rootFromPage === '' ? '' : `${rootFromPage.split('/').map(encodeURIComponent).join('/')}/`}${encodedPath(sourcePath)}`
}
