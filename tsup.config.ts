import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    format: ['esm'],
    dts: true,
    sourcemap: true,
    clean: true,
  },
  {
    entry: { 'cli/index': 'src/cli/index.ts' },
    format: ['esm'],
    sourcemap: true,
    banner: { js: '#!/usr/bin/env node' },
  },
]);
