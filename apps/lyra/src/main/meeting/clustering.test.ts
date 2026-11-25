import { describe, expect, it } from 'vitest'
import { centroids, clusterLongWindows } from './clustering'

const spans = [
  { start: 0, end: 3 },
  { start: 1.5, end: 4.5 },
  { start: 3, end: 6 },
  { start: 10, end: 13 },
  { start: 11.5, end: 14.5 },
  { start: 14.5, end: 15 }
]
const a = [1, 0, 0]
const b = [0, 1, 0]
const vectors = [a, [0.98, 0.2, 0], a, b, [0.1, 0.99, 0], b]

describe('clusterLongWindows with a non-finite voiceprint', () => {
  it('gives the same labels as before for finite input', () => {
    expect(clusterLongWindows(spans, vectors, 0.3, 1)).toEqual([0, 0, 0, 1, 1, 1])
  })

  it('clusters without a NaN window and gives it the nearest window’s label', () => {
    const broken = vectors.map((vector, i) => (i === 4 ? [NaN, NaN, NaN] : vector))
    expect(clusterLongWindows(spans, broken, 0.3, 1)).toEqual([0, 0, 0, 1, 1, 1])
    const first = vectors.map((vector, i) => (i === 0 ? [Infinity, 0, 0] : vector))
    expect(clusterLongWindows(spans, first, 0.3, 1)).toEqual([0, 0, 0, 1, 1, 1])
  })

  it('leaves non-finite vectors out of the centroids', () => {
    const centres = centroids([0, 0], [a, [NaN, 1, 0]])
    expect(centres.get(0)).toEqual([1, 0, 0])
  })
})
