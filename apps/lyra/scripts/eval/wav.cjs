// 16 kHz mono PCM16 WAV in and out, the only format Lyra's pipeline reads.
const { readFileSync, writeFileSync } = require('node:fs')

const RATE = 16000

/** Reads a 16 kHz mono 16-bit WAV into floats in [-1, 1]. */
function readWav(path) {
  const buf = readFileSync(path)
  let offset = 12
  let format = null
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4)
    const size = buf.readUInt32LE(offset + 4)
    if (id === 'fmt ') {
      format = { channels: buf.readUInt16LE(offset + 10), rate: buf.readUInt32LE(offset + 12), bits: buf.readUInt16LE(offset + 22) }
    }
    if (id === 'data') {
      if (!format) throw new Error(`${path}: no fmt chunk before data`)
      if (format.channels !== 1 || format.rate !== RATE || format.bits !== 16) {
        throw new Error(`${path} is ${format.channels} ch / ${format.rate} Hz / ${format.bits}-bit; need 16 kHz mono 16-bit`)
      }
      const count = Math.floor(Math.min(size, buf.length - offset - 8) / 2)
      const samples = new Float32Array(count)
      for (let i = 0; i < count; i++) samples[i] = buf.readInt16LE(offset + 8 + i * 2) / 32768
      return samples
    }
    // Some writers put 0xFFFFFFFF in a streamed data size; that case is handled above.
    offset += 8 + size + (size % 2)
  }
  throw new Error(`${path}: no data chunk`)
}

/** Writes floats as a 16 kHz mono 16-bit WAV, clipping anything outside [-1, 1]. */
function writeWav(path, samples) {
  const out = Buffer.alloc(44 + samples.length * 2)
  out.write('RIFF', 0, 'ascii')
  out.writeUInt32LE(36 + samples.length * 2, 4)
  out.write('WAVEfmt ', 8, 'ascii')
  out.writeUInt32LE(16, 16)
  out.writeUInt16LE(1, 20)
  out.writeUInt16LE(1, 22)
  out.writeUInt32LE(RATE, 24)
  out.writeUInt32LE(RATE * 2, 28)
  out.writeUInt16LE(2, 32)
  out.writeUInt16LE(16, 34)
  out.write('data', 36, 'ascii')
  out.writeUInt32LE(samples.length * 2, 40)
  for (let i = 0; i < samples.length; i++) {
    const value = Math.max(-1, Math.min(1, samples[i]))
    out.writeInt16LE(Math.round(value * 32767), 44 + i * 2)
  }
  writeFileSync(path, out)
}

module.exports = { RATE, readWav, writeWav }
