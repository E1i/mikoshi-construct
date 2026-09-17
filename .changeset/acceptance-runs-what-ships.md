---
"mikoshi-construct": patch
---

Acceptance now runs the artifact that actually ships. Each leg installs the packed tarball into a directory outside the repository and invokes the installed `construct` binary for `init` and `doctor`, instead of `node dist/cli.js` out of the working tree. That is what publishing exercises: externals tsup leaves out must resolve from the installed package's own dependencies, `files` must carry `templates/` or the first template read fails, and `bin` must point at the built entry — running from the workspace proves none of the three, which is why nine legs went red at once. A drift guard asserts no bare import under `src/` resolves to a devDependency; it is green today and stays that way on purpose.
