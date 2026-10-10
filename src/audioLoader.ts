import * as path from 'node:path';
import { decodeWav } from './wavDecoder.js';
import { computePeaks } from './dsp.js';

export interface WaveformData {
  peaks: number[][];
  duration: number;
  sampleRate: number;
  channels: number;
  fileName: string;
  /** Set when the clip is too large to preview; shown in the editor. */
  previewNotice?: string;
}

const PEAK_COUNT = 2000;

export async function loadAudioPeaks(filePath: string): Promise<WaveformData> {
  const decoded = await decodeWav(filePath);

  const channels: Float32Array[] = [];
  for (let c = 0; c < decoded.numberOfChannels; c++) channels.push(decoded.getChannelData(c));
  const peaks = computePeaks(channels, PEAK_COUNT);

  return {
    peaks,
    duration: decoded.duration,
    sampleRate: decoded.sampleRate,
    channels: decoded.numberOfChannels,
    fileName: path.basename(filePath),
  };
}
