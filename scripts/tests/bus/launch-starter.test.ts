import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { HTTPS_ORIGIN_ENV } from '../../bus/launch-starter.js'

function gitConfig(args: string[]): string {
  return execFileSync('git', ['config', ...args], { encoding: 'utf8', env: { ...process.env, ...HTTPS_ORIGIN_ENV } }).replace(/\n$/, '')
}

describe('the launch env', () => {
  it('the launch env gives git a credential helper for https://github.com', () => {
    expect(gitConfig(['--get-urlmatch', 'credential.helper', 'https://github.com/E1i/mikoshi-construct.git'])).toBe('!gh auth git-credential')
    expect(gitConfig(['--get-all', 'credential.https://github.com.helper']).split('\n')).toEqual(['', '!gh auth git-credential'])
  })

  it('the launch env rewrites both ssh forms of a github origin to https', () => {
    expect(gitConfig(['--get-all', 'url.https://github.com/.insteadOf']).split('\n')).toEqual(['git@github.com:', 'ssh://git@github.com/'])
  })
})
