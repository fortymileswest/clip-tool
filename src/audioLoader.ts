import * as path from 'node:path';
import { decodeWav } from './wavDecoder.js';

export interface WaveformData {
  peaks: number[][];
  duration: number;
  sampleRate: number;
  channels: number;
  fileName: string;
}

const PEAK_COUNT = 2000;

export async function loadAudioPeaks(filePath: string): Promise<WaveformData> {
  const decoded = await decodeWav(filePath);

  const peaks: number[][] = [];
  for (let c = 0; c < decoded.numberOfChannels; c++) {
    const channelData = decoded.getChannelData(c);
    const blockSize = Math.max(1, Math.floor(channelData.length / PEAK_COUNT));
    const channelPeaks: number[] = [];

    for (let i = 0; i < PEAK_COUNT; i++) {
      const start = i * blockSize;
      const end = Math.min(start + blockSize, channelData.length);
      let min = 0;
      let max = 0;
      for (let j = start; j < end; j++) {
        const v = channelData[j]!;
        if (v < min) min = v;
        if (v > max) max = v;
      }
      channelPeaks.push(min, max);
    }
    peaks.push(channelPeaks);
  }

  return {
    peaks,
    duration: decoded.duration,
    sampleRate: decoded.sampleRate,
    channels: decoded.numberOfChannels,
    fileName: path.basename(filePath),
  };
}
