import * as fs from 'node:fs/promises';

export interface DecodedAudio {
  numberOfChannels: number;
  sampleRate: number;
  duration: number;
  getChannelData(channel: number): Float32Array;
}

const WAVE_FORMAT_PCM = 1;
const WAVE_FORMAT_IEEE_FLOAT = 3;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;

// The 14 bytes that follow the 2-byte format code in a KSDATAFORMAT_SUBTYPE_* GUID
// (xxxx0000-0000-0010-8000-00aa00389b71), as stored little-endian in the file.
const SUBFORMAT_GUID_TAIL = [0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71];

// Minimal WAV decoder: integer PCM in 8/16/24/32-bit containers (including
// 20-in-24 and similar, which are read by their container size), and 32/64-bit
// IEEE float, in plain or WAVE_FORMAT_EXTENSIBLE headers. Anything else is
// rejected with a clear error rather than decoded as silence. No dependencies.
export async function decodeWav(filePath: string, onProgress?: (progress: number) => void | Promise<void>): Promise<DecodedAudio> {
  const buf = await fs.readFile(filePath);
  return decodeWavBuffer(buf, onProgress);
}

export async function decodeWavBuffer(
  buf: Uint8Array,
  onProgress?: (progress: number) => void | Promise<void>,
): Promise<DecodedAudio> {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  if (buf.byteLength < 12 || readTag(view, 0) !== 'RIFF' || readTag(view, 8) !== 'WAVE') {
    throw new Error('Not a WAV file (Clip Tool reads WAV only; set Live\'s Record File Type to WAV)');
  }

  let offset = 12;
  let fmt: {
    formatTag: number;
    channels: number;
    sampleRate: number;
    blockAlign: number;
    bitsPerSample: number;
    subFormat: number | null;
  } | null = null;
  let dataOffset = -1;
  let dataSize = 0;

  while (offset + 8 <= buf.byteLength) {
    const tag = readTag(view, offset);
    const size = view.getUint32(offset + 4, true);
    offset += 8;

    if (tag === 'fmt ') {
      if (size < 16 || offset + 16 > buf.byteLength) throw new Error('Malformed WAV: fmt chunk too short');
      const formatTag = view.getUint16(offset, true);
      let subFormat: number | null = null;
      if (formatTag === WAVE_FORMAT_EXTENSIBLE) {
        // cbSize(2) at 16, validBits(2) at 18, channelMask(4) at 20, GUID(16) at 24.
        if (size < 40 || offset + 40 > buf.byteLength) {
          throw new Error('Malformed WAV: extensible fmt chunk too short');
        }
        subFormat = view.getUint16(offset + 24, true);
        for (let i = 0; i < SUBFORMAT_GUID_TAIL.length; i++) {
          if (view.getUint8(offset + 26 + i) !== SUBFORMAT_GUID_TAIL[i]) {
            throw new Error('Unsupported WAV format: unknown extensible sub-format');
          }
        }
      }
      fmt = {
        formatTag,
        channels: view.getUint16(offset + 2, true),
        sampleRate: view.getUint32(offset + 4, true),
        blockAlign: view.getUint16(offset + 12, true),
        bitsPerSample: view.getUint16(offset + 14, true),
        subFormat,
      };
    } else if (tag === 'data' && dataOffset < 0) {
      dataOffset = offset;
      // Clamp to the bytes actually present: a truncated file, or a writer that
      // left the 0xFFFFFFFF "unknown length" placeholder in the header.
      dataSize = Math.min(size, buf.byteLength - offset);
    }
    offset += size + (size % 2); // chunks are word-aligned
  }

  if (!fmt || !fmt.channels || !fmt.sampleRate || dataOffset < 0) {
    throw new Error('Malformed WAV: missing fmt or data chunk');
  }

  const { channels, sampleRate } = fmt;
  const code = fmt.formatTag === WAVE_FORMAT_EXTENSIBLE ? fmt.subFormat! : fmt.formatTag;
  // The container size comes from blockAlign, not bitsPerSample: 20-bit audio
  // sits in 3-byte containers, where bits >> 3 would give 2.
  const bytesPerSample = fmt.blockAlign > 0 && fmt.blockAlign % channels === 0
    ? fmt.blockAlign / channels
    : Math.ceil(fmt.bitsPerSample / 8);

  let isFloat: boolean;
  if (code === WAVE_FORMAT_PCM && bytesPerSample >= 1 && bytesPerSample <= 4) {
    isFloat = false;
  } else if (code === WAVE_FORMAT_IEEE_FLOAT && (bytesPerSample === 4 || bytesPerSample === 8)) {
    isFloat = true;
  } else {
    throw new Error(
      `Unsupported WAV format: ${describeFormat(code)} with ${bytesPerSample * 8}-bit samples ` +
      '(Clip Tool reads 8/16/24/32-bit PCM and 32/64-bit float)',
    );
  }

  const blockAlign = channels * bytesPerSample;
  const frameCount = Math.floor(dataSize / blockAlign);
  const duration = frameCount / sampleRate;

  const channelBuffers: Float32Array[] = Array.from(
    { length: channels },
    () => new Float32Array(frameCount),
  );

  for (let i = 0; i < frameCount; i++) {
    if (onProgress && i % 100000 === 0) await onProgress(i / frameCount);
    for (let c = 0; c < channels; c++) {
      const pos = dataOffset + i * blockAlign + c * bytesPerSample;
      channelBuffers[c]![i] = readSample(view, pos, bytesPerSample, isFloat);
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

function describeFormat(code: number): string {
  if (code === WAVE_FORMAT_PCM) return 'PCM';
  if (code === WAVE_FORMAT_IEEE_FLOAT) return 'float';
  return `format code 0x${code.toString(16).padStart(4, '0')}`;
}

function readTag(view: DataView, offset: number): string {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}

/** Reads one sample by container size. Smaller valid bit depths (e.g. 20-in-24)
 *  are left-justified in the container, so the container scale is correct. */
function readSample(
  view: DataView,
  pos: number,
  bytes: number,
  isFloat: boolean,
): number {
  if (isFloat) {
    return bytes === 8
      ? view.getFloat64(pos, true)
      : view.getFloat32(pos, true);
  }
  switch (bytes) {
    case 1:
      return (view.getUint8(pos) - 128) / 128;
    case 2:
      return view.getInt16(pos, true) / 32768;
    case 3: {
      const lo = view.getUint8(pos);
      const mi = view.getUint8(pos + 1);
      const hi = view.getInt8(pos + 2);
      return ((hi << 16) | (mi << 8) | lo) / 8388608;
    }
    default:
      return view.getInt32(pos, true) / 2147483648;
  }
}
