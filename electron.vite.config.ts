import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        external: ['@kutalia/whisper-node-addon', 'sherpa-onnx-node'],
        input: {
          index: resolve('src/main/index.ts'),
          // Runs in a utilityProcess: speaker diarization off the main thread.
          speakerWorker: resolve('src/main/meeting/worker.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react()]
  }
})
