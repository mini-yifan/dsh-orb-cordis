import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/child.ts', 'src/aec-worker.ts', 'src/tts-worker.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: true,
  // The microphone and speech engines stay native packages beside the child.
  deps: { neverBundle: ['pinyin-pro', 'sherpa-onnx-node', 'node-cpal'] },
})
