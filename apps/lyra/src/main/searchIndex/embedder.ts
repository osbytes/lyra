import type { LlamaEmbeddingContext } from 'node-llama-cpp'
import { loadLlamaModule } from '../llamaModule'

/**
 * Text embeddings for semantic search, in the index worker. Vectors are unit length, so
 * `vector_distance_cos` is 1 − their dot product.
 */
export type Embedder = {
  /** Stored with each vector (embeddingSpace): vectors from another space are never compared. */
  space: string
  embed(text: string, kind: 'document' | 'query'): Promise<Float32Array>
}

/** Every embedder produces this many dimensions (the `vectors` column is F32_BLOB(768)). */
export const EMBEDDING_DIMS = 768

/**
 * Bump when what gets embedded changes without the model changing: the task prefixes below, or
 * how record.ts cuts and labels chunks. The old vectors then stop matching and are re-embedded,
 * instead of being compared with vectors made another way.
 */
export const EMBED_RECIPE = 2

/**
 * What a vector is comparable with: the model file's sha256 (not its name, which a new
 * quantization or revision could keep), the dimensions and the recipe.
 */
export function embeddingSpace(modelSha256: string): string {
  return `${modelSha256}:${String(EMBEDDING_DIMS)}:r${String(EMBED_RECIPE)}`
}

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
export async function createLlamaEmbedder(modelPath: string, modelSha256: string): Promise<Embedder> {
  const { getLlama } = await loadLlamaModule()
  const llama = await getLlama()
  const loaded = await llama.loadModel({ modelPath })
  // Two threads: indexing runs in the background and mustn't starve live transcription.
  const context: LlamaEmbeddingContext = await loaded.createEmbeddingContext({ contextSize: 2048, threads: 2 })
  return {
    space: embeddingSpace(modelSha256),
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
    space: embeddingSpace('hash-words'),
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
