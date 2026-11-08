import type { Verdict } from '../../ci/prepush.js'
import type { Capability, CapabilityProbes } from '../../ci/sandbox-failing.js'
import { describe, expect, it } from 'vitest'
import { prepushGate } from '../../ci/prepush.js'
import { CAPABILITIES, declaredCapabilities, probeCapabilities, sandboxNorm } from '../../ci/sandbox-failing.js'

const LISTENS = 'scripts/tests/bus/netwatch.test.ts > the hook server answers [needs net-listen]'
const READS_PS = 'scripts/tests/ports/process-table.test.ts > a live session is found in the table [needs ps]'
const REAL = 'scripts/tests/core/queue.test.ts > a lease expires after its window'

function red(...failed: string[]): () => Verdict {
  return () => ({ kind: 'red', failed })
}

function sandboxWithout(...missing: Capability[]): ReadonlySet<Capability> {
  return new Set(CAPABILITIES.filter(capability => !missing.includes(capability)))
}

describe('tests declare the capabilities they need, and the sandbox reads its own', () => {
  it('a test declares a capability in its name, and an undeclared or unknown one is not read', () => {
    expect(declaredCapabilities(LISTENS)).toEqual(['net-listen'])
    expect(declaredCapabilities(`${READS_PS} [needs miko-session]`)).toEqual(['ps', 'miko-session'])
    expect(declaredCapabilities(REAL)).toEqual([])
    expect(declaredCapabilities('a test [needs gpu]')).toEqual([])
  })

  it('the sandbox probes each capability once, and a probe that throws reads as missing', async () => {
    const called: Capability[] = []
    const probes: CapabilityProbes = {
      'net-listen': async () => {
        called.push('net-listen')
        return false
      },
      'ps': async () => {
        called.push('ps')
        return true
      },
      'miko-session': async () => {
        called.push('miko-session')
        throw new Error('EPERM')
      },
    }

    expect([...await probeCapabilities(probes)]).toEqual(['ps'])
    expect(called.sort()).toEqual([...CAPABILITIES].sort())
  })

  it('a failure of a test whose declared capability the sandbox lacks is marked as sandbox norm, apart from real reds', () => {
    const available = sandboxWithout('net-listen')

    expect(sandboxNorm([LISTENS, READS_PS, REAL], available)).toEqual({ norm: [{ key: LISTENS, missing: ['net-listen'] }], real: [READS_PS, REAL] })

    const gate = prepushGate(['scripts/notes/print.ts'], red(LISTENS, REAL), () => [], available)
    expect(gate.code).toBe(1)
    expect(gate.lines).toContain(`failed: ${REAL}`)
    expect(gate.lines).not.toContain(`failed: ${LISTENS}`)
    expect(gate.lines).toContain(`sandbox norm: no net-listen — ${LISTENS}`)
  })

  it('a pre-push red only on sandbox norm failures also red on main does not ask for another run', () => {
    const gate = prepushGate(['scripts/notes/print.ts'], red(LISTENS, READS_PS), () => [], sandboxWithout('net-listen', 'ps'))

    expect(gate.code).toBe(0)
    expect(gate.lines).toContain(`sandbox norm: no net-listen — ${LISTENS}`)
    expect(gate.lines).toContain(`sandbox norm: no ps — ${READS_PS}`)
    expect(gate.lines.join('\n')).not.toContain('run the gate again')
    expect(gate.lines.join('\n')).toContain('red on main here too')
  })

  it('a declared capability the sandbox has leaves its failure a real red', () => {
    const gate = prepushGate(['scripts/notes/print.ts'], red(LISTENS), () => [], sandboxWithout())

    expect(gate.code).toBe(1)
    expect(gate.lines).toContain(`failed: ${LISTENS}`)
  })
})
