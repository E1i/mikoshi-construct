import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { stringify } from 'yaml'
import { listTemplateFiles, render } from '../src/materialize/templates.js'

const REPO_ROOT = path.resolve(import.meta.dirname, '..')
const VITEST = path.join(REPO_ROOT, 'node_modules', '.bin', 'vitest')
const CONTRACT_PATH = 'contracts/api/openapi.yaml'
const SECURITY_TEST = 'scripts/tests/contracts/security.test.ts'
const SCHEME_TEST = 'declares one of the contract\'s own security schemes on every operation under a protected prefix'
const ADMIN_SCOPE_TEST = 'names the admin scope on every admin operation whose scheme marks one'

type Requirement = Record<string, string[]>

interface ContractShape {
  schemes: Record<string, unknown>
  admin?: Requirement[]
  me?: Requirement[]
  rootSecurity?: Requirement[]
}

const COOKIE_SESSION = { type: 'apiKey', in: 'cookie', name: 'session' }
const SESSION = [{ session: [] }]

function operation(id: string, security: Requirement[] | undefined): Record<string, unknown> {
  return {
    operationId: id,
    ...(security == null ? {} : { security }),
    responses: { 200: { description: 'ok' } },
  }
}

function contractOf(shape: ContractShape): string {
  return stringify({
    openapi: '3.1.0',
    info: { title: 'fixture', version: '0.1.0' },
    ...(shape.rootSecurity == null ? {} : { security: shape.rootSecurity }),
    paths: {
      '/health': { get: operation('getHealth', [{}]) },
      '/v1/admin/users': { get: operation('listUsers', shape.admin) },
      '/v1/me': { get: operation('getMe', shape.me) },
    },
    components: { schemas: {}, securitySchemes: shape.schemes },
  })
}

function renderedSecurityTest(): string {
  const template = listTemplateFiles('stacks/http-contract').find(file => file.target === SECURITY_TEST)
  if (template == null)
    throw new Error(`stacks/http-contract renders no ${SECURITY_TEST}`)
  return render(readFileSync(template.source, 'utf8'), { contractPath: CONTRACT_PATH })
}

function failedTests(shape: ContractShape): string[] {
  const tree = mkdtempSync(path.join(tmpdir(), 'http-contract-security-'))
  const report = path.join(tree, 'report.json')
  try {
    mkdirSync(path.join(tree, path.dirname(SECURITY_TEST)), { recursive: true })
    mkdirSync(path.join(tree, path.dirname(CONTRACT_PATH)), { recursive: true })
    writeFileSync(path.join(tree, SECURITY_TEST), renderedSecurityTest())
    writeFileSync(path.join(tree, CONTRACT_PATH), contractOf(shape))
    symlinkSync(path.join(REPO_ROOT, 'node_modules'), path.join(tree, 'node_modules'))
    spawnSync(VITEST, ['run', '--root', tree, '--reporter=json', `--outputFile.json=${report}`], {
      cwd: tree,
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1', CI: '1' },
    })
    const results = JSON.parse(readFileSync(report, 'utf8')) as {
      testResults: Array<{ assertionResults: Array<{ title: string, status: string }> }>
    }
    const assertions = results.testResults.flatMap(file => file.assertionResults)
    expect(assertions.map(result => result.title)).toEqual(expect.arrayContaining([SCHEME_TEST, ADMIN_SCOPE_TEST]))
    return assertions.filter(result => result.status !== 'passed').map(result => result.title)
  }
  finally {
    rmSync(tree, { recursive: true, force: true })
  }
}

describe('the rendered http-contract security test', () => {
  it('accepts a cookie session scheme', () => {
    expect(failedTests({ schemes: { session: COOKIE_SESSION }, admin: SESSION, me: SESSION })).toEqual([])
  })

  it.each([
    ['http bearer', { type: 'http', scheme: 'bearer' }],
    ['apiKey in a header', { type: 'apiKey', in: 'header', name: 'X-Api-Key' }],
    ['oauth2', { type: 'oauth2', flows: { clientCredentials: { tokenUrl: 'https://auth.example.invalid/token', scopes: { read: 'read' } } } }],
    ['openIdConnect', { type: 'openIdConnect', openIdConnectUrl: 'https://auth.example.invalid/.well-known/openid-configuration' }],
  ])('accepts a scheme of another type: %s', (_type, scheme) => {
    expect(failedTests({ schemes: { session: scheme }, admin: SESSION, me: SESSION })).toEqual([])
  })

  it('accepts a contract-wide security default the operations inherit', () => {
    expect(failedTests({ schemes: { session: COOKIE_SESSION }, rootSecurity: SESSION })).toEqual([])
  })

  it.each<[string, Requirement[] | undefined, Requirement[] | undefined]>([
    ['names no scheme', undefined, undefined],
    ['overrides the default with an empty list', [], SESSION],
    ['allows anonymous access as an alternative', [{ session: [] }, {}], undefined],
    ['names a scheme securitySchemes does not define', [{ bearer: [] }], undefined],
    ['names an inherited object property', [{ constructor: [] }], undefined],
  ])('rejects an operation without a declared scheme: %s', (_case, admin, rootSecurity) => {
    expect(failedTests({ schemes: { session: COOKIE_SESSION }, admin, me: SESSION, rootSecurity })).toEqual([SCHEME_TEST])
  })

  it('rejects a /v1/me operation without a declared scheme', () => {
    expect(failedTests({ schemes: { session: COOKIE_SESSION }, admin: SESSION })).toEqual([SCHEME_TEST])
  })

  it('accepts a contract that marks no admin scope', () => {
    expect(failedTests({ schemes: { session: COOKIE_SESSION }, admin: [{ session: ['staff'] }], me: SESSION })).toEqual([])
  })

  it('accepts an admin operation that names the scope its scheme declares', () => {
    const schemes = { session: { type: 'oauth2', flows: { clientCredentials: { tokenUrl: 'https://auth.example.invalid/token', scopes: { admin: 'administer' } } } } }
    expect(failedTests({ schemes, admin: [{ session: ['admin'] }], me: SESSION })).toEqual([])
  })

  it('rejects an admin operation that omits the scope its oauth2 scheme declares', () => {
    const schemes = { session: { type: 'oauth2', flows: { clientCredentials: { tokenUrl: 'https://auth.example.invalid/token', scopes: { admin: 'administer' } } } } }
    expect(failedTests({ schemes, admin: SESSION, me: SESSION })).toEqual([ADMIN_SCOPE_TEST])
  })

  it('rejects an admin operation that omits the scope another operation names on its scheme', () => {
    expect(failedTests({ schemes: { session: COOKIE_SESSION }, admin: SESSION, me: [{ session: ['admin'] }] })).toEqual([ADMIN_SCOPE_TEST])
  })
})
