import type { Reporter, TestModule, Vitest, VitestPluginContext } from 'vitest/node'
import process from 'node:process'

const REPORTERS_WRITING_INTO_THE_TREE = ['json', 'junit']

type ReporterReference = Vitest['config']['reporters'][number]

function nameOf(reference: ReporterReference): string | null {
  return Array.isArray(reference) && typeof reference[0] === 'string' ? reference[0] : null
}

function outputFileOf(reference: ReporterReference): unknown {
  if (!Array.isArray(reference))
    return undefined
  const options = reference[1] as { outputFile?: unknown } | undefined
  return options?.outputFile
}

function configuredOutputFile(config: Vitest['config'], reporter: string): unknown {
  const { outputFile } = config
  if (outputFile === undefined || typeof outputFile === 'string')
    return outputFile
  return outputFile[reporter]
}

export function reportersWithoutOutputFile(config: Vitest['config']): string[] {
  return config.reporters
    .map(reference => nameOf(reference))
    .filter((name): name is string => name !== null && REPORTERS_WRITING_INTO_THE_TREE.includes(name))
    .filter(name => !config.reporters.some(reference => nameOf(reference) === name && outputFileOf(reference) !== undefined))
    .filter(name => configuredOutputFile(config, name) === undefined)
}

export function testsThatRan(testModules: ReadonlyArray<TestModule>): number {
  return testModules
    .flatMap(testModule => [...testModule.children.allTests()])
    .filter(test => ['passed', 'failed'].includes(test.result().state))
    .length
}

export class NoMatchReporter implements Reporter {
  private vitest: Vitest | null = null

  onInit(vitest: Vitest): void {
    this.vitest = vitest
  }

  onTestRunEnd(testModules: ReadonlyArray<TestModule>): void {
    const pattern = this.vitest?.config.testNamePattern
    if (pattern === undefined || testsThatRan(testModules) > 0)
      return
    this.vitest?.logger.error(`the name filter ${String(pattern)} matched no test: a witness that matches nothing cannot fail, so this run fails`)
    process.exitCode = 1
  }
}

export function witnessGuard(): { name: string, configureVitest: (context: VitestPluginContext) => void } {
  return {
    name: 'witness-guard',
    configureVitest({ vitest }) {
      const unwritten = reportersWithoutOutputFile(vitest.config)
      if (unwritten.length > 0)
        throw new Error(`the ${unwritten.join(', ')} report has no outputFile: vitest would write it under .vitest/ in the tree and print only its path, so a grep on stdout never sees it; pass --outputFile.${unwritten[0]}=<a temporary file outside the tree> and read that file`)
      vitest.config.reporters.push(new NoMatchReporter())
    },
  }
}
