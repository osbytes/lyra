import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        external: ['@kutalia/whisper-node-addon', 'sherpa-onnx-node', 'onnxruntime-node', 'node-llama-cpp', '@libsql/client'],
        input: {
          index: resolve('src/main/index.ts'),
          // Runs in a utilityProcess: speaker diarization off the main thread.
          speakerWorker: resolve('src/main/meeting/worker.ts'),
          // Runs in a utilityProcess: the larger speaker model, whose ONNX Runtime can't share
          // the speaker worker's process with sherpa-onnx's (meeting/activityProtocol.ts).
          activityWorker: resolve('src/main/meeting/activityWorker.ts'),
          // Runs in a utilityProcess: local meeting notes with llama.cpp.
          notesWorker: resolve('src/main/meeting/notesWorker.ts'),
          // Runs in a utilityProcess: the search index database (libSQL).
          indexWorker: resolve('src/main/searchIndex/worker.ts')
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
    plugins: [react(), tailwindcss()]
  }
})
