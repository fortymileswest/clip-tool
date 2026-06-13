import * as fs from 'node:fs/promises';

// Minimal WAV encoder — writes 32-bit IEEE float, which Live imports natively
// and preserves the full precision of the Float32Array processing pipeline.
// No external dependencies.
export async function encodeWavFile(
  filePath: string,
  channels: Float32Array[],
  sampleRate: number,
): Promise<void> {
  const numChannels = channels.length;
  if (numChannels === 0) throw new Error('encodeWavFile: no channels');
  const frameCount = channels[0]!.length;

  const bytesPerSample = 4;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = frameCount * blockAlign;

  // RIFF header (12) + fmt chunk (8+18) + fact chunk (8+4) + data header (8)
  const headerSize = 12 + 26 + 12 + 8;
  const buf = Buffer.alloc(headerSize + dataSize);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let o = 0;

  const writeTag = (tag: string) => {
    for (let i = 0; i < 4; i++) view.setUint8(o + i, tag.charCodeAt(i));
    o += 4;
  };

  writeTag('RIFF');
  view.setUint32(o, headerSize + dataSize - 8, true); o += 4;
  writeTag('WAVE');

  // fmt chunk: WAVE_FORMAT_IEEE_FLOAT requires the cbSize field (18-byte fmt)
  writeTag('fmt ');
  view.setUint32(o, 18, true); o += 4;
  view.setUint16(o, 3, true); o += 2;            // audioFormat 3 = IEEE float
  view.setUint16(o, numChannels, true); o += 2;
  view.setUint32(o, sampleRate, true); o += 4;
  view.setUint32(o, sampleRate * blockAlign, true); o += 4; // byte rate
  view.setUint16(o, blockAlign, true); o += 2;
  view.setUint16(o, 32, true); o += 2;           // bits per sample
  view.setUint16(o, 0, true); o += 2;            // cbSize

  // fact chunk: required by the spec for non-PCM formats
  writeTag('fact');
  view.setUint32(o, 4, true); o += 4;
  view.setUint32(o, frameCount, true); o += 4;

  writeTag('data');
  view.setUint32(o, dataSize, true); o += 4;

  for (let i = 0; i < frameCount; i++) {
    for (let c = 0; c < numChannels; c++) {
      view.setFloat32(o, channels[c]![i]!, true);
      o += 4;
    }
  }

  await fs.writeFile(filePath, buf);
}
