import { describe, expect, it } from 'vitest'
import { BUILD_SHA, currentVersion, interfaceVersion } from '../../src/version.js'
import { BUILD_SHA_CONSTANT, buildSha, factoryBuild, productBuild } from '../../tsup.config.js'

describe('the board names its interface version from the package and the build', () => {
  it('is the package version alone when no build sha was stamped', () => {
    expect(BUILD_SHA).toBeNull()
    expect(interfaceVersion()).toBe(currentVersion())
    expect(interfaceVersion('0.47.0', null)).toBe('0.47.0')
  })

  it('appends the short build sha when the build stamped one', () => {
    expect(interfaceVersion('0.47.0', 'abc1234')).toBe('0.47.0+abc1234')
  })

  it('both builds stamp the short head sha into the same constant', () => {
    const sha = buildSha()
    expect(sha).toMatch(/^[0-9a-f]{7,}$/)
    for (const build of [productBuild, factoryBuild])
      expect(build.define).toEqual({ [BUILD_SHA_CONSTANT]: JSON.stringify(sha) })
  })
})
