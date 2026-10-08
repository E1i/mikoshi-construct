import { execFileSync } from 'node:child_process'

const MIKOSHI_PROMPT = 'Прочитай ~/.construct/handoff/mikoshi.md и продолжай как Mikoshi'
const MIKOSHI_SESSION = `cd ~/projects/mikoshi-construct && GH_TOKEN=$(gh auth token --user E1i) caffeinate -dis claude --permission-mode auto \\"${MIKOSHI_PROMPT}\\"`
const NEW_TERMINAL_RUNNING_MIKOSHI = `tell app "Terminal" to do script "${MIKOSHI_SESSION}"`

execFileSync('osascript', ['-e', NEW_TERMINAL_RUNNING_MIKOSHI], { stdio: 'inherit' })
