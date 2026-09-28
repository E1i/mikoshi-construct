export const FAST_PATH_ALLOWED: readonly RegExp[] = [
  /^docs\/.+/,
  /^architecture\/[^/]+\.md$/,
]

export function isFastPath(paths: readonly string[]): boolean {
  return paths.length > 0 && paths.every(file => FAST_PATH_ALLOWED.some(allowed => allowed.test(file)))
}
