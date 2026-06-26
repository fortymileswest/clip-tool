import * as fs from 'node:fs/promises';

export interface DecodedAudio {
  numberOfChannels: number;
  sampleRate: number;
  duration: number;
  getChannelData(channel: number): Float32Array;
}

// Minimal WAV decoder — handles PCM 8/16/24/32-bit int and 32/64-bit float.
// Ableton exports WAV files in these formats. No external dependencies.
export async function decodeWav(filePath: string, onProgress?: (progress: number) => void | Promise<void>): Promise<DecodedAudio> {
  const buf = await fs.readFile(filePath);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  if (readTag(view, 0) !== 'RIFF' || readTag(view, 8) !== 'WAVE') {
    throw new Error('Not a WAV file');
  }

  let offset = 12;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let audioFormat = 0;
  let dataOffset = 0;
  let dataSize = 0;

  while (offset + 8 <= buf.byteLength) {
    const tag = readTag(view, offset);
    const size = view.getUint32(offset + 4, true);
    offset += 8;

    if (tag === 'fmt ') {
      audioFormat = view.getUint16(offset, true);
      channels = view.getUint16(offset + 2, true);
      sampleRate = view.getUint32(offset + 4, true);
      bitsPerSample = view.getUint16(offset + 14, true);
    } else if (tag === 'data') {
      dataOffset = offset;
      dataSize = size;
      break;
    }
    offset += size + (size % 2); // chunks are word-aligned
  }

  if (!channels || !sampleRate || dataOffset === 0) {
    throw new Error('Malformed WAV: missing fmt or data chunk');
  }

  // audioFormat: 1 = PCM int, 3 = IEEE float, 0xFFFE = extensible (treat as PCM/float)
  const isFloat = audioFormat === 3;
  const bytesPerSample = bitsPerSample >> 3;
  const frameCount = Math.floor(dataSize / (channels * bytesPerSample));
  const duration = frameCount / sampleRate;

  const channelBuffers: Float32Array[] = Array.from(
    { length: channels },
    () => new Float32Array(frameCount),
  );

  for (let i = 0; i < frameCount; i++) {
    if (onProgress && i % 100000 === 0) await onProgress(i / frameCount);
    for (let c = 0; c < channels; c++) {
      const pos = dataOffset + (i * channels + c) * bytesPerSample;
      channelBuffers[c]![i] = readSample(view, pos, bitsPerSample, isFloat);
    }
  }
  if (onProgress) await onProgress(1);

  return {
    numberOfChannels: channels,
    sampleRate,
    duration,
    getChannelData: (ch) => channelBuffers[ch]!,
  };
}

function readTag(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}

function readSample(
  view: DataView,
  pos: number,
  bits: number,
  isFloat: boolean,
): number {
  if (isFloat) {
    return bits === 64
      ? view.getFloat64(pos, true)
      : view.getFloat32(pos, true);
  }
  switch (bits) {
    case 8:
      return (view.getUint8(pos) - 128) / 128;
    case 16:
      return view.getInt16(pos, true) / 32768;
    case 24: {
      const lo = view.getUint8(pos);
      const mi = view.getUint8(pos + 1);
      const hi = view.getInt8(pos + 2);
      return ((hi << 16) | (mi << 8) | lo) / 8388608;
    }
    case 32:
      return view.getInt32(pos, true) / 2147483648;
    default:
      return 0;
  }
}
