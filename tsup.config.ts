import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['esm'],
  target: 'node20',
  clean: true,
  removeNodeProtocol: false,
  banner: { js: '#!/usr/bin/env node' },
})
