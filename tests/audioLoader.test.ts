import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import * as url from 'node:url';
import { loadAudioPeaks } from '../src/audioLoader.ts';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, 'fixtures', 'sine440.wav');

test('loadAudioPeaks returns correct shape for stereo WAV', async () => {
  const data = await loadAudioPeaks(FIXTURE);
  assert.equal(data.channels, 2);
  assert.equal(data.peaks.length, 2);
  assert.equal(data.peaks[0]!.length, 2000 * 2); // 2000 min/max pairs per channel
  assert.ok(data.duration > 0);
  assert.ok(data.sampleRate > 0);
  assert.ok(data.fileName.endsWith('.wav'));
});

test('loadAudioPeaks peak values are in [-1, 1]', async () => {
  const data = await loadAudioPeaks(FIXTURE);
  for (const channel of data.peaks) {
    for (const v of channel) {
      assert.ok(v >= -1 && v <= 1, `Peak value ${v} out of range`);
    }
  }
});
