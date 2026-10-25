export interface BuiltPage {
  page: string
  html: string
}

export interface BrokenFileLink {
  page: string
  href: string
}

export function brokenFileLinks(pages: BuiltPage[], base: string, exists: (file: string) => boolean): BrokenFileLink[] {
  return pages.flatMap(({ page, html }) =>
    [...html.matchAll(/href="([^"#?]+\.html)"/g)]
      .map(match => match[1])
      .filter(href => href.startsWith('/') && !(href.startsWith(base) && exists(href.slice(base.length))))
      .map(href => ({ page, href })))
}
