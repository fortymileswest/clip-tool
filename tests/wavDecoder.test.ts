import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { decodeWav, decodeWavBuffer } from '../src/wavDecoder.ts';
import { encodeWavFile } from '../src/wavEncoder.ts';

const PCM = 1;
const FLOAT = 3;
const EXTENSIBLE = 0xfffe;

interface Spec {
  formatTag: number;
  channels: number;
  sampleRate?: number;
  bitsPerSample: number;
  containerBytes?: number;
  subFormat?: number;
  /** Bytes of sample data, already encoded. */
  data: Uint8Array;
  /** Override the size written in the data chunk header. */
  dataSizeField?: number;
  /** Extra chunk placed between fmt and data. */
  extraChunk?: { tag: string; body: Uint8Array };
}

function chunk(tag: string, body: Uint8Array, sizeField = body.length): Uint8Array {
  const pad = body.length % 2;
  const out = new Uint8Array(8 + body.length + pad);
  const v = new DataView(out.buffer);
  for (let i = 0; i < 4; i++) out[i] = tag.charCodeAt(i);
  v.setUint32(4, sizeField, true);
  out.set(body, 8);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function buildWav(s: Spec): Uint8Array {
  const sampleRate = s.sampleRate ?? 48000;
  const bytes = s.containerBytes ?? s.bitsPerSample / 8;
  const blockAlign = s.channels * bytes;
  const ext = s.formatTag === EXTENSIBLE;
  const fmt = new Uint8Array(ext ? 40 : 16);
  const v = new DataView(fmt.buffer);
  v.setUint16(0, s.formatTag, true);
  v.setUint16(2, s.channels, true);
  v.setUint32(4, sampleRate, true);
  v.setUint32(8, sampleRate * blockAlign, true);
  v.setUint16(12, blockAlign, true);
  v.setUint16(14, ext ? bytes * 8 : s.bitsPerSample, true);
  if (ext) {
    v.setUint16(16, 22, true);              // cbSize
    v.setUint16(18, s.bitsPerSample, true); // valid bits
    v.setUint32(20, s.channels === 2 ? 3 : 4, true);
    v.setUint16(24, s.subFormat ?? PCM, true);
    fmt.set([0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71], 26);
  }
  const parts = [chunk('fmt ', fmt)];
  if (s.extraChunk) parts.push(chunk(s.extraChunk.tag, s.extraChunk.body));
  parts.push(chunk('data', s.data, s.dataSizeField));
  const body = concat(parts);
  const header = new Uint8Array(12);
  const hv = new DataView(header.buffer);
  for (let i = 0; i < 4; i++) header[i] = 'RIFF'.charCodeAt(i);
  hv.setUint32(4, body.length + 4, true);
  for (let i = 0; i < 4; i++) header[8 + i] = 'WAVE'.charCodeAt(i);
  return concat([header, body]);
}

/** Interleaved integer samples → little-endian bytes in `bytes`-wide containers. */
function intData(values: number[], bytes: number): Uint8Array {
  const out = new Uint8Array(values.length * bytes);
  const v = new DataView(out.buffer);
  values.forEach((x, i) => {
    const o = i * bytes;
    if (bytes === 2) v.setInt16(o, x, true);
    else if (bytes === 4) v.setInt32(o, x, true);
    else if (bytes === 3) { out[o] = x & 0xff; out[o + 1] = (x >> 8) & 0xff; out[o + 2] = (x >> 16) & 0xff; }
  });
  return out;
}

function floatData(values: number[]): Uint8Array {
  const out = new Uint8Array(values.length * 4);
  const v = new DataView(out.buffer);
  values.forEach((x, i) => v.setFloat32(i * 4, x, true));
  return out;
}

function close(a: number, b: number, eps = 1e-6) {
  assert.ok(Math.abs(a - b) <= eps, `${a} vs ${b}`);
}

test('16-bit PCM stereo decodes to the right values per channel', async () => {
  const wav = buildWav({ formatTag: PCM, channels: 2, bitsPerSample: 16, data: intData([16384, -16384, -32768, 32767], 2) });
  const d = await decodeWavBuffer(wav);
  assert.equal(d.numberOfChannels, 2);
  assert.equal(d.sampleRate, 48000);
  assert.deepEqual([...d.getChannelData(0)], [0.5, -1]);
  close(d.getChannelData(1)[0]!, -0.5);
  close(d.getChannelData(1)[1]!, 32767 / 32768);
});

test('24-bit PCM mono decodes, including negative values', async () => {
  const wav = buildWav({ formatTag: PCM, channels: 1, bitsPerSample: 24, data: intData([4194304, -4194304, -8388608], 3) });
  const d = await decodeWavBuffer(wav);
  assert.deepEqual([...d.getChannelData(0)], [0.5, -0.5, -1]);
});

test('32-bit PCM decodes', async () => {
  const wav = buildWav({ formatTag: PCM, channels: 1, bitsPerSample: 32, data: intData([1073741824, -2147483648], 4) });
  const d = await decodeWavBuffer(wav);
  assert.deepEqual([...d.getChannelData(0)], [0.5, -1]);
});

test('20-bit audio in 3-byte containers uses blockAlign, not bits >> 3', async () => {
  // Left-justified 20-bit values: 0.5 full scale is 0x400000 in the container.
  const wav = buildWav({ formatTag: PCM, channels: 2, bitsPerSample: 20, containerBytes: 3, data: intData([0x400000, -0x400000, 0x200000, 0], 3) });
  const d = await decodeWavBuffer(wav);
  assert.equal(d.getChannelData(0).length, 2);
  assert.deepEqual([...d.getChannelData(0)], [0.5, 0.25]);
  assert.deepEqual([...d.getChannelData(1)], [-0.5, 0]);
});

test('32-bit float decodes', async () => {
  const wav = buildWav({ formatTag: FLOAT, channels: 1, bitsPerSample: 32, data: floatData([0.25, -0.75, 1.5]) });
  const d = await decodeWavBuffer(wav);
  assert.deepEqual([...d.getChannelData(0)], [0.25, -0.75, 1.5]);
});

test('WAVE_FORMAT_EXTENSIBLE with a float sub-format reads as float', async () => {
  const wav = buildWav({ formatTag: EXTENSIBLE, subFormat: FLOAT, channels: 2, bitsPerSample: 32, data: floatData([0.25, -0.25, 0.5, -0.5]) });
  const d = await decodeWavBuffer(wav);
  assert.deepEqual([...d.getChannelData(0)], [0.25, 0.5]);
  assert.deepEqual([...d.getChannelData(1)], [-0.25, -0.5]);
});

test('WAVE_FORMAT_EXTENSIBLE with a PCM sub-format reads as integer', async () => {
  const wav = buildWav({ formatTag: EXTENSIBLE, subFormat: PCM, channels: 1, bitsPerSample: 24, data: intData([4194304, -8388608], 3) });
  const d = await decodeWavBuffer(wav);
  assert.deepEqual([...d.getChannelData(0)], [0.5, -1]);
});

test('an odd-sized chunk before data is skipped with its pad byte', async () => {
  const wav = buildWav({
    formatTag: PCM, channels: 1, bitsPerSample: 16,
    extraChunk: { tag: 'LIST', body: new Uint8Array([1, 2, 3]) },
    data: intData([16384, -16384], 2),
  });
  const d = await decodeWavBuffer(wav);
  assert.deepEqual([...d.getChannelData(0)], [0.5, -0.5]);
});

test('a truncated data chunk decodes only the frames present', async () => {
  const full = buildWav({ formatTag: PCM, channels: 2, bitsPerSample: 16, data: intData([1, 2, 3, 4, 5, 6], 2) });
  // Cut mid-way through the third frame.
  const cut = full.subarray(0, full.length - 3);
  const d = await decodeWavBuffer(cut);
  assert.equal(d.getChannelData(0).length, 2);
  close(d.duration, 2 / 48000);
});

test('a 0xFFFFFFFF data size placeholder is clamped to the file', async () => {
  const wav = buildWav({ formatTag: PCM, channels: 1, bitsPerSample: 16, data: intData([16384, 16384, 16384], 2), dataSizeField: 0xffffffff });
  const d = await decodeWavBuffer(wav);
  assert.equal(d.getChannelData(0).length, 3);
});

test('unsupported formats are rejected with a clear error', async () => {
  const alaw = buildWav({ formatTag: 6, channels: 1, bitsPerSample: 8, data: new Uint8Array(4) });
  await assert.rejects(decodeWavBuffer(alaw), /Unsupported WAV format: format code 0x0006/);
  const float16 = buildWav({ formatTag: FLOAT, channels: 1, bitsPerSample: 16, data: new Uint8Array(4) });
  await assert.rejects(decodeWavBuffer(float16), /Unsupported WAV format: float with 16-bit/);
  const extAdpcm = buildWav({ formatTag: EXTENSIBLE, subFormat: 2, channels: 1, bitsPerSample: 16, data: new Uint8Array(4) });
  await assert.rejects(decodeWavBuffer(extAdpcm), /Unsupported WAV format/);
  await assert.rejects(decodeWavBuffer(new TextEncoder().encode('FORM....AIFF')), /Not a WAV file/);
});

test('encoder output round-trips through the decoder', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cliptool-wav-'));
  try {
    const file = path.join(dir, 'rt.wav');
    const left = new Float32Array([0, 0.1, -0.2, 0.999, -1]);
    const right = new Float32Array([0.5, -0.5, 0.25, -0.25, 0]);
    await encodeWavFile(file, [left, right], 44100);
    const d = await decodeWav(file);
    assert.equal(d.numberOfChannels, 2);
    assert.equal(d.sampleRate, 44100);
    assert.deepEqual([...d.getChannelData(0)], [...left]);
    assert.deepEqual([...d.getChannelData(1)], [...right]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
