import { describe, expect, it } from 'vitest'
import { commandFromHelp, listsCommands, usageCommands } from '../../scripts/contract/help.js'
import { HEAD_CLI } from '../../scripts/contract/json-samples.js'
import { commandsFromHelp, headCommands } from '../../scripts/contract/surface.js'

const ROOT_HELP = `mikoshi-construct — bootstrap (construct v0.17.2)

USAGE construct init|attach|jack-in|soulkill|inspect

COMMANDS

      init    Materialize the construct
`

const INIT_HELP = `Materialize the construct (construct init v0.17.2)

USAGE construct init [OPTIONS] 

OPTIONS

                   --dir=<dir>    Target directory (Default: .)
                       --plain    No colors, no lore (CI-friendly) (Default: false)
  --reviewModel=<review_model>    Model for the review workflow
                     -y, --yes    Non-interactive (Default: false)
                  --no-verbose    Quiet
                     --verbose    Chatty (Default: true)
`

const MUTATE_HELP = `Apply a named wrong implementation (construct mutate v0.19.0)

USAGE construct mutate apply|judge

COMMANDS

  apply    Apply one named wrong implementation
  judge    Restore and judge
`

const MUTATE_APPLY_HELP = `Apply one named wrong implementation (mutate apply)

USAGE mutate apply [OPTIONS] 

OPTIONS

  --dir=<dir>    Target directory (Default: .)
    --id=<id>    The id of the mutation line to apply
       --json    Machine-readable report (Default: false)
`

describe('the command surface read from --help', () => {
  it('lists every command and alias named in the root USAGE line', () => {
    expect(usageCommands(ROOT_HELP)).toEqual(['init', 'attach', 'jack-in', 'soulkill', 'inspect'])
  })

  it('reads flags, their value hints and their short aliases, dropping the negated variant of a boolean', () => {
    expect(commandFromHelp('init', INIT_HELP)).toEqual({
      flags: {
        dir: { type: 'string' },
        plain: { type: 'boolean' },
        reviewModel: { type: 'string' },
        yes: { type: 'boolean', alias: 'y' },
        verbose: { type: 'boolean' },
      },
    })
  })

  it('reads a name whose header names another command as an alias of it', () => {
    expect(commandFromHelp('inspect', 'Extract the facts (alias: inspect, capture) (construct soulkill v0.17.2)\n')).toEqual({ aliasOf: 'soulkill' })
  })

  it('lists the subcommands a command group names in its own USAGE line', () => {
    expect(usageCommands(MUTATE_HELP)).toEqual(['apply', 'judge'])
    expect(listsCommands(MUTATE_HELP)).toBe(true)
    expect(listsCommands(INIT_HELP)).toBe(false)
  })

  it('reads a subcommand whose header names its parent and carries no version', () => {
    expect(commandFromHelp('mutate apply', MUTATE_APPLY_HELP)).toEqual({ flags: { dir: { type: 'string' }, id: { type: 'string' }, json: { type: 'boolean' } } })
  })

  it('reads a subcommand whose header names another subcommand as an alias of it', () => {
    expect(commandFromHelp('mutate run', 'Apply (mutate apply)\n')).toEqual({ aliasOf: 'mutate apply' })
  })

  it('refuses a command with positional arguments rather than guess their names', () => {
    expect(() => commandFromHelp('graph', 'Draw (construct graph v1)\n\nUSAGE construct graph <OUT>\n\nARGUMENTS\n\n  OUT    Where\n')).toThrow('positional arguments')
  })

  it('refuses an option line it cannot read as a flag', () => {
    expect(() => commandFromHelp('init', 'Init (construct init v1)\n\nOPTIONS\n\n  dir    Target\n')).toThrow('not a flag: dir    Target')
  })

  it('reads HEAD\'s own --help as the commands HEAD\'s program declares', () => {
    expect(commandsFromHelp(HEAD_CLI)).toEqual(headCommands())
  }, 120_000)
})
