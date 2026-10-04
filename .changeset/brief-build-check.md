---
"mikoshi-construct": patch
---

ghosts: `pnpm ghosts:hash` runs `check-acceptance build` on the brief's `/implement` text first and prints no hash when the build fails, naming its first error; when the build passes it prints the whole line for the `.approved-sha256` file, `approved /implement text sha256: <hash> (<date>, Eli; sketch <short sha>|none)`, instead of the bare hash
