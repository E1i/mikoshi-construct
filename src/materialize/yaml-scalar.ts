const SAFE_PLAIN_SCALAR = /^[a-z][\w .,/=+@%&|-]*$/i
const TRAILING_SPACE = /\s$/
const RESOLVES_TO_A_NON_STRING = /^(?:y|yes|n|no|true|false|on|off|null)$/i

export function yamlScalar(value: string): string {
  const plain = SAFE_PLAIN_SCALAR.test(value) && !TRAILING_SPACE.test(value) && !RESOLVES_TO_A_NON_STRING.test(value)
  return plain ? value : JSON.stringify(value)
}
