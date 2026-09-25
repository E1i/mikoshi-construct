import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'

interface SchemaNode {
  $ref?: string
  additionalProperties?: boolean | SchemaNode
}

interface MediaTypes {
  content?: Record<string, { schema: SchemaNode }>
}

interface Operation {
  operationId: string
  security?: Array<Record<string, unknown>>
  requestBody?: MediaTypes
  responses?: Record<string, MediaTypes>
}

interface ContractDocument {
  paths: Record<string, Record<string, Operation>>
  components: { schemas: Record<string, SchemaNode> }
}

const contract = parse(readFileSync(new URL('../../../contracts/api/openapi.yaml', import.meta.url), 'utf8')) as ContractDocument

const PROTECTED_PREFIXES = ['/v1/admin', '/v1/me']

function operations(prefix: string): Array<{ route: string, method: string, operation: Operation }> {
  return Object.entries(contract.paths)
    .filter(([route]) => route.startsWith(prefix))
    .flatMap(([route, methods]) => Object.entries(methods).map(([method, operation]) => ({ route, method, operation })))
}

function resolveSchema(schema: SchemaNode): SchemaNode {
  return schema.$ref == null
    ? schema
    : resolveSchema(contract.components.schemas[schema.$ref.replace('#/components/schemas/', '')])
}

function jsonRequestBodies(): Array<{ route: string, method: string, schema: SchemaNode }> {
  return Object.entries(contract.paths).flatMap(([route, methods]) =>
    Object.entries(methods).flatMap(([method, operation]) => {
      const schema = operation.requestBody?.content?.['application/json']?.schema
      return schema == null ? [] : [{ route, method, schema: resolveSchema(schema) }]
    }))
}

function jsonResponseBodies(): Array<{ route: string, method: string, status: string, schema: SchemaNode }> {
  return Object.entries(contract.paths).flatMap(([route, methods]) =>
    Object.entries(methods).flatMap(([method, operation]) =>
      Object.entries(operation.responses ?? {}).flatMap(([status, response]) => {
        const schema = response.content?.['application/json']?.schema
        return schema == null ? [] : [{ route, method, status, schema: resolveSchema(schema) }]
      })))
}

function requires(operation: Operation, scheme: string): boolean {
  const schemes = operation.security ?? []
  return schemes.length > 0 && schemes.every(entry => scheme in entry)
}

describe('security invariants stated by the contract', () => {
  it('declares every operation with an operationId', () => {
    for (const { route, method, operation } of operations('/'))
      expect({ route, method, operationId: typeof operation.operationId }).toEqual({ route, method, operationId: 'string' })
  })

  it('requires a bearer session on every operation under a protected prefix', () => {
    for (const prefix of PROTECTED_PREFIXES) {
      for (const { route, method, operation } of operations(prefix))
        expect({ route, method, bearer: requires(operation, 'bearer') }).toEqual({ route, method, bearer: true })
    }
  })

  it('closes every documented JSON request body, so no write can set a field the contract does not expose', () => {
    for (const { route, method, schema } of jsonRequestBodies())
      expect({ route, method, closed: schema.additionalProperties }).toEqual({ route, method, closed: false })
  })

  it('closes every documented JSON response body, so no response can leak a field the contract does not expose', () => {
    for (const { route, method, status, schema } of jsonResponseBodies())
      expect({ route, method, status, closed: schema.additionalProperties }).toEqual({ route, method, status, closed: false })
  })
})
