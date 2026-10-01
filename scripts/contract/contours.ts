import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

export const CONTOURS_DIR = path.resolve(import.meta.dirname, '../../contract/contours')

const SCHEMA_SUFFIX = '.schema.json'
const READ_TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']
const DEFS_PREFIX = '#/$defs/'

export interface ContourSchema {
  $id?: string
  $ref?: string
  $defs?: Record<string, ContourSchema>
  type?: string
  required?: string[]
  properties?: Record<string, ContourSchema>
  items?: ContourSchema
  enum?: unknown[]
  const?: unknown
  pattern?: string
  minLength?: number
  anyOf?: ContourSchema[]
  allOf?: ContourSchema[]
  if?: ContourSchema
  then?: ContourSchema
  else?: ContourSchema
  not?: ContourSchema
}

export function contourSchemaNames(): string[] {
  return readdirSync(CONTOURS_DIR).filter(file => file.endsWith(SCHEMA_SUFFIX)).map(file => file.slice(0, -SCHEMA_SUFFIX.length)).sort()
}

export function readContourSchema(name: string): ContourSchema {
  return JSON.parse(readFileSync(path.join(CONTOURS_DIR, `${name}${SCHEMA_SUFFIX}`), 'utf8')) as ContourSchema
}

export function schemaId(schema: ContourSchema): string {
  if (typeof schema.$id !== 'string')
    throw new Error('no $id')
  return schema.$id
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function hasType(value: unknown, type: string): boolean {
  switch (type) {
    case 'object': return isRecord(value)
    case 'array': return Array.isArray(value)
    case 'string': return typeof value === 'string'
    case 'number': return typeof value === 'number' && Number.isFinite(value)
    case 'integer': return Number.isInteger(value)
    case 'boolean': return typeof value === 'boolean'
    default: return value === null
  }
}

function resolve(ref: string, root: ContourSchema): ContourSchema {
  if (ref === '#')
    return root
  const target = ref.startsWith(DEFS_PREFIX) ? root.$defs?.[ref.slice(DEFS_PREFIX.length)] : undefined
  if (target === undefined)
    throw new Error(`cannot resolve $ref ${ref}`)
  return target
}

function child(at: string, key: string | number): string {
  return typeof key === 'number' ? `${at}[${key}]` : at === '' ? key : `${at}.${key}`
}

export function violations(value: unknown, schema: ContourSchema, at = '', root: ContourSchema = schema): string[] {
  const label = at === '' ? 'value' : at
  if (schema.$ref !== undefined)
    return violations(value, resolve(schema.$ref, root), at, root)
  if (schema.type !== undefined) {
    if (!READ_TYPES.includes(schema.type))
      throw new Error(`type ${schema.type} is not read`)
    if (!hasType(value, schema.type))
      return [`${label}: expected ${schema.type}`]
  }
  const faults: string[] = []
  if (schema.enum !== undefined && !schema.enum.includes(value))
    faults.push(`${label}: expected one of ${schema.enum.map(option => JSON.stringify(option)).join(', ')}`)
  if (schema.const !== undefined && schema.const !== value)
    faults.push(`${label}: expected ${JSON.stringify(schema.const)}`)
  if (schema.pattern !== undefined && typeof value === 'string' && !new RegExp(schema.pattern).test(value))
    faults.push(`${label}: does not match ${schema.pattern}`)
  if (schema.minLength !== undefined && typeof value === 'string' && value.length < schema.minLength)
    faults.push(`${label}: shorter than ${schema.minLength}`)
  if (isRecord(value)) {
    for (const key of schema.required ?? []) {
      if (!(key in value))
        faults.push(`${child(at, key)}: missing`)
    }
    for (const [key, property] of Object.entries(schema.properties ?? {})) {
      if (key in value)
        faults.push(...violations(value[key], property, child(at, key), root))
    }
  }
  if (Array.isArray(value) && schema.items !== undefined) {
    const items = schema.items
    value.forEach((entry, index) => faults.push(...violations(entry, items, child(at, index), root)))
  }
  if (schema.anyOf !== undefined && !schema.anyOf.some(option => violations(value, option, at, root).length === 0))
    faults.push(`${label}: matches none of ${schema.anyOf.length} alternatives`)
  for (const part of schema.allOf ?? [])
    faults.push(...violations(value, part, at, root))
  if (schema.if !== undefined) {
    const branch = violations(value, schema.if, at, root).length === 0 ? schema.then : schema.else
    if (branch !== undefined)
      faults.push(...violations(value, branch, at, root))
  }
  if (schema.not !== undefined && violations(value, schema.not, at, root).length === 0)
    faults.push(`${label}: forbidden here`)
  return faults
}
