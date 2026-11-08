import { defineConfig } from 'tsdown'

const external = [
  'koffi',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-tools',
]

/**
 * Bundle the plugin and the child-process host. The host is a separate entry
 * because the native library must never load inside the Host process: a Rust
 * panic or a stuck platform call would take the whole desktop app down.
 */
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    host: 'src/host.ts',
    'cli-path': 'src/cli-path.ts',
  },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: true,
  clean: true,
  deps: { neverBundle: external },
})