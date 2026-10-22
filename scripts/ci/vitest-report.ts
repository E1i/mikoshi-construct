import path from 'node:path'

export interface VitestAssertion { ancestorTitles: string[], title: string, status: string, failureMessages: string[] }
export interface VitestFile { name: string, status: string, message?: string, assertionResults: VitestAssertion[] }
export interface VitestReport { testResults: VitestFile[] }

export interface TestOutcome { file: string, name: string, state: string, messages: string[] }

export const NAME_SEPARATOR = ' > '

export function testKey(file: string, name: string): string {
  return `${file}${NAME_SEPARATOR}${name}`
}

export function outcomesOf(report: VitestReport, root: string): TestOutcome[] {
  return report.testResults.flatMap((result) => {
    const file = path.relative(root, result.name)
    const tests = result.assertionResults.map(test => ({ file, name: [...test.ancestorTitles, test.title].join(NAME_SEPARATOR), state: test.status, messages: test.failureMessages }))
    return result.status === 'failed' && result.assertionResults.every(test => test.status !== 'failed')
      ? [...tests, { file, name: '', state: 'failed', messages: [result.message ?? ''] }]
      : tests
  })
}
