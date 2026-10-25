# HIJACK: the construct in a repository it did not write

`construct attach` (alias `jack-in`) brings the `/plan` command, the `/implement` skill, the agents and the
ladder script into a repository without touching a tracked file. It hides what it writes through
`.git/info/exclude` and records it in `.construct/attach.json`; `construct detach` (alias `jack-out`)
removes it again ([CLI reference](/cli#construct-attach)).

```bash
npx mikoshi-construct attach --harness "npm test"
```

The full guide to what attach creates, what it leaves alone, when it refuses and how to detach is
[Working in a repository the construct did not write](/guide/attach). The flow is
`architecture/composition/attach.yaml`, described in `architecture/attach.md`
([Architecture](/guide/architecture/attach)).
