import { defineConfig } from 'tsdown'

const external = [
  'koffi',
  'zod',
  '@deepseek-ai/cordis',
  '@deepseek-ai/schemastery',
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-api-session-controller',
  '@deepseek-ai/dsh-attachment',
  '@deepseek-ai/dsh-brand',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-session-projection',
  '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-user-approval',
  '@deepseek-ai/dsh-user-questions',
]

/** Bundle the GUI plugin, the code-agent entry, and the registry provider. Leave Host packages external. */
export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'code-agent': 'src/code-agent.ts',
    'code-agent-registry': 'src/code-agent-registry.ts',
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
