import { describe, expect, it } from 'vitest'
import { SANDBOX_FAILING } from '../../ci/sandbox-failing.js'
import { refusalsIn, REFUSED_LINE } from '../../ci/sandbox-refusals.js'

const NPM_REGISTRY_REFUSAL = 'npm registry 403'
const MKDTEMP_REFUSAL = 'mkdtemp under $TMPDIR EPERM'
const RUN_ROOT = 'scripts/tests/scratch/run-root.test.ts'
const NPM_REGISTRY_SUITES = ['tests/factory-start.test.ts', 'tests/hijack-deploy-beside.test.ts', 'tests/intake-from-package.test.ts', 'tests/package-factory.test.ts']
const REGISTRY_403_IN_EACH_PROXY_WORDING = [
  'Command failed: npm install\nnpm error code E403\nnpm error 403 403 user denied - GET https://registry.npmjs.org/@clack%2fprompts\nnpm error 403 In most cases, you or one of your dependencies',
  'Command failed: npm install\nnpm error code E403\nnpm error 403 403 not in this command\'s allowed_domains ? re-run the command with this host listed if it needs it - GET https://registry.npmjs.org/@clack%2fprompts\nnpm error 403 In most cases, you or one of your dependencies',
]

describe('the sandbox list holds what the session sandbox refuses on main', () => {
  it.each(NPM_REGISTRY_SUITES)('%s is listed whole under the npm registry refusal', (file) => {
    expect(SANDBOX_FAILING).toContainEqual({ file, test: '', refused: NPM_REGISTRY_REFUSAL })
  })

  it('names of run-root hold only the two tests the sandbox still refuses, each under its own refusal', () => {
    expect(SANDBOX_FAILING.filter(entry => entry.file === RUN_ROOT)).toEqual([
      { file: RUN_ROOT, test: 'pnpm test > leaves no Vitest temp dir in a fresh outer TMPDIR when vitest runs through run.ts', refused: 'listen EPERM on the tsx IPC pipe' },
      { file: RUN_ROOT, test: 'run.ts, the root quality runs in > passes and leaves nothing when the command creates temp directories inside the root', refused: MKDTEMP_REFUSAL },
    ])
  })

  it('the mkdtemp refusal kind reads the line the sandbox prints', () => {
    expect(refusalsIn('mktemp: mkdtemp failed on /var/folders/kh/T/tmp.qE3Drc2DxQ: Operation not permitted')).toEqual([MKDTEMP_REFUSAL])
  })

  it.each(REGISTRY_403_IN_EACH_PROXY_WORDING)('the npm registry refusal survives the trace\'s line filter: %s', (failure) => {
    expect(refusalsIn((failure.match(REFUSED_LINE) ?? []).join('\n'))).toEqual([NPM_REGISTRY_REFUSAL])
  })

  it('a 403 from another registry is not read as the sandbox refusing the npm registry', () => {
    expect(refusalsIn('npm error 403 403 Forbidden - GET https://npm.example.test/left-pad')).toEqual([])
  })
})
