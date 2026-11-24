import type { LlamaEmbeddingContext } from 'node-llama-cpp'
import { loadLlamaModule } from '../llamaModule'

/**
 * Text embeddings for semantic search, in the index worker. Vectors are unit length, so
 * `vector_distance_cos` is 1 − their dot product.
 */
export type Embedder = {
  /** Stored with each vector: vectors from another model are ignored and replaced. */
  model: string
  embed(text: string, kind: 'document' | 'query'): Promise<Float32Array>
}

/** Every embedder produces this many dimensions (the `embeddings` column is F32_BLOB(768)). */
export const EMBEDDING_DIMS = 768

function unit(values: ArrayLike<number>): Float32Array {
  const vector = Float32Array.from(values)
  let length = 0
  for (const value of vector) length += value * value
  length = Math.sqrt(length) || 1
  return vector.map((value) => value / length)
}

/**
 * nomic-embed-text-v1.5 through llama.cpp. It was trained with task prefixes, which matter: a
 * query and the passage that answers it only score close with them.
 */
export async function createLlamaEmbedder(modelPath: string, model: string): Promise<Embedder> {
  const { getLlama } = await loadLlamaModule()
  const llama = await getLlama()
  const loaded = await llama.loadModel({ modelPath })
  // Two threads: indexing runs in the background and mustn't starve live transcription.
  const context: LlamaEmbeddingContext = await loaded.createEmbeddingContext({ contextSize: 2048, threads: 2 })
  return {
    model,
    async embed(text, kind) {
      const prefix = kind === 'query' ? 'search_query: ' : 'search_document: '
      const { vector } = await context.getEmbeddingFor(prefix + text)
      if (vector.length !== EMBEDDING_DIMS) throw new Error(`Embedding has ${String(vector.length)} dimensions`)
      return unit(vector)
    }
  }
}

/**
 * A stand-in for tests: words hashed into buckets, so texts that share words score close. It
 * exercises the whole pipeline without a 146 MB download; it knows nothing about meaning.
 */
export function createHashEmbedder(): Embedder {
  return {
    model: 'hash-words-768',
    embed(text) {
      const vector = new Float32Array(EMBEDDING_DIMS)
      for (const [word] of text.toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)) {
        let hash = 2166136261
        for (let i = 0; i < word.length; i++) hash = Math.imul(hash ^ word.charCodeAt(i), 16777619)
        const bucket = (hash >>> 0) % EMBEDDING_DIMS
        vector[bucket] = (vector[bucket] ?? 0) + 1
      }
      return Promise.resolve(unit(vector))
    }
  }
}
