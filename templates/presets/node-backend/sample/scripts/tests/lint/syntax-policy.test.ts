import { ESLint } from 'eslint'
import { describe, expect, it } from 'vitest'
import { REPO_ROOT } from '../../composition/files.js'

const PROCESS = 'MemberExpression[object.name="process"]'
const RAW_REQUEST_DATA = 'MemberExpression[object.name="req"][property.name=/^(body|query|params)$/]'
const RAW_SQL = 'CallExpression[callee.object.name="sql"][callee.property.name="raw"]'

const eslint = new ESLint({ cwd: REPO_ROOT })

async function restrictedSelectors(file: string): Promise<string[]> {
  const config = await eslint.calculateConfigForFile(file)
  const [, ...restrictions] = config.rules['no-restricted-syntax'] as [unknown, ...Array<{ selector: string }>]
  return restrictions.map(restriction => restriction.selector).sort()
}

const ROLES: Array<{ role: string, file: string, selectors: string[] }> = [
  { role: 'a service', file: 'src/things/things.service.ts', selectors: [PROCESS, RAW_REQUEST_DATA, RAW_SQL] },
  { role: 'a controller', file: 'src/things/things.controller.ts', selectors: [PROCESS, RAW_SQL] },
  { role: 'a middleware', file: 'src/http/error-handler.middleware.ts', selectors: [PROCESS, RAW_SQL] },
  { role: 'the app config', file: 'src/config.ts', selectors: [RAW_SQL] },
  { role: 'the process entry', file: 'src/server.ts', selectors: [RAW_SQL] },
]

describe('syntax policy by file role', () => {
  for (const { role, file, selectors } of ROLES) {
    it(`keeps every restriction that applies to ${role}`, async () => {
      expect(await restrictedSelectors(file)).toEqual([...selectors].sort())
    })
  }
})
