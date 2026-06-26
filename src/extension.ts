import { initialize, AudioClip, AudioTrack } from '@ableton-extensions/sdk';
import type { ActivationContext, Handle, Simpler } from '@ableton-extensions/sdk';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

// CJS global — available at runtime; TypeScript ESNext module mode doesn't know about it
declare const __dirname: string;

import { loadAudioPeaks } from './audioLoader.js';
import { processAudio } from './processor.js';
import type { ProcessOptions } from './processor.js';
import { nextOutputPath, uniqueNamedPath } from './projectPaths.js';

// esbuild text loader — index.html is inlined as a string at build time
import editorHtml from './webview/index.html';

interface ProcessResult {
  cancelled: boolean;
  mode?: 'replace' | 'copy' | 'simpler';
  trimStart: number;
  trimEnd: number;
  gain_dB: number;
  channel: 'left' | 'right' | 'mixed' | 'stereo' | 'side';
  crop: boolean;
  stretchRatio?: number;
  stretchCyclic?: boolean;
  fadeIn?: { len: number; type: 'linear' | 'exp' | 'log' | 's'; bend: number } | null;
  fadeOut?: { len: number; type: 'linear' | 'exp' | 'log' | 's'; bend: number } | null;
  removeDc?: boolean;
  preventClipping?: boolean;
  pitchSemitones?: number;
  stretchWindowMs?: number;
  stretchTransient?: number;
  /** Renamed sample (stem, no extension); blank/absent keeps the original name. */
  outputName?: string;
}

function buildModalHtml(
  waveformData: object,
  audioDataSrc: string,
  waveformJs: string,
  controlsJs: string,
  timestretchJs: string,
  fadesJs: string,
  fontsCss: string,
): string {
  // Escape '<' so a value like a filename containing "</script>" cannot close
  // the inline <script> block early. The JS parser reads < back as '<'.
  const waveformJson = JSON.stringify(waveformData).replace(/</g, '\\u003c');
  return editorHtml
    // Inlined Inter @font-face (base64 woff2) — keeps the modal self-contained.
    .replace('/* FONT_FACE_PLACEHOLDER */', fontsCss)
    .replace(
      '/* WAVEFORM_DATA_PLACEHOLDER */',
      // Must be a window property: a top-level const in a classic script is not
      // attached to window, and controls.js reads it from window. The (large)
      // audio bytes are delivered separately via audioDataSrc, loaded after the
      // UI markup so the modal paints first.
      `window.WAVEFORM_DATA = ${waveformJson};`,
    )
    // Load the audio bytes as an external subresource right before the UI
    // scripts (i.e. after the body markup), so a long clip's megabytes no longer
    // block the parser ahead of the UI.
    .replace(
      '<script src="timestretch.js"></script>',
      // onerror flags a failed subresource load so getDecodedBuffer can report it
      // instead of silently doing nothing (preview/deep-zoom would otherwise just
      // not respond if the temp .js failed to load).
      `<script src="${audioDataSrc}" onerror="window.AUDIO_WAV_LOAD_FAILED=true"></script>\n<script>\n${timestretchJs}\n</script>`,
    )
    .replace('<script src="fades.js"></script>', `<script>\n${fadesJs}\n</script>`)
    .replace('<script src="waveform.js"></script>', `<script>\n${waveformJs}\n</script>`)
    .replace('<script src="controls.js"></script>', `<script>\n${controlsJs}\n</script>`);
}

export async function activate(activation: ActivationContext) {
  const context = initialize(activation, '1.0.0');

  // Cache webview assets once at activation — they are static files that do not change at runtime.
  const webviewDir = path.join(__dirname, 'webview');
  const [waveformJs, controlsJs, timestretchJs, fadesJs, fontsCss] = await Promise.all([
    fs.readFile(path.join(webviewDir, 'waveform.js'), 'utf-8'),
    fs.readFile(path.join(webviewDir, 'controls.js'), 'utf-8'),
    fs.readFile(path.join(webviewDir, 'timestretch.js'), 'utf-8'),
    fs.readFile(path.join(webviewDir, 'fades.js'), 'utf-8'),
    fs.readFile(path.join(webviewDir, 'fonts.css'), 'utf-8'),
  ]);

  context.ui.registerContextMenuAction('AudioClip', 'Clip Tool', 'audioeditor.open');

  async function handleAudioEdit(handle: Handle): Promise<void> {
    const clip = context.getObjectFromHandle(handle, AudioClip);

    const startTime = clip.startTime;
    const endTime = clip.endTime;

    // clip.parent is DataModelObject | null; the parent of an arrangement AudioClip is always
    // its AudioTrack. The SDK does not export AudioTrack as a newable class, so instanceof
    // is not available — double-cast is the SDK-documented pattern.
    const parentObj = clip.parent;
    if (!parentObj) {
      console.error('[Audio Editor] Clip has no parent track');
      return;
    }
    const track = parentObj as unknown as AudioTrack<'1.0.0'>;

    // The Extension Host sandboxes Node's filesystem access: the source sample
    // (often outside the project, e.g. on a cloud drive) is not readable, and its
    // directory is not writable. renderPreFxAudio is the sanctioned path — Live
    // renders the clip's arrangement range to a WAV in the extension's temp
    // directory, which we are allowed to read and write.
    const renderedPath = (await context.ui.withinProgressDialog(
      'Audio Editor',
      { progress: 0 },
      async (update) => {
        await update('Rendering clip audio…', 30);
        return context.resources.renderPreFxAudio(track, startTime, endTime);
      },
    )) as string;

    const waveformData = await loadAudioPeaks(renderedPath);
    // Show the original sample's name in the editor, not the temp render's.
    const displayPath = clip.filePath ?? renderedPath;
    waveformData.fileName = path.basename(displayPath);

    // Deliver the rendered audio for Web Audio preview as a SEPARATE script file
    // beside the HTML, not inlined. A long clip is tens of MB of base64; inlined
    // ahead of the UI markup it blocked the webview parser so the modal opened
    // blank until a restart (issue #1). As an external subresource the UI paints
    // first, then the audio loads.
    const tempDir = context.environment.tempDirectory ?? path.dirname(renderedPath);
    const stamp = Date.now();
    const audioDataName = `audio-editor-data-${stamp}.js`;
    const audioDataPath = path.join(tempDir, audioDataName);
    const audioB64 = (await fs.readFile(renderedPath)).toString('base64');
    // base64's charset (A-Za-z0-9+/=) contains nothing that needs escaping in a
    // double-quoted JS string, so concatenate directly rather than JSON.stringify
    // the whole tens-of-MB payload (which would copy and scan it a second time).
    await fs.writeFile(audioDataPath, `window.AUDIO_WAV_B64="${audioB64}";`, 'utf-8');

    const html = buildModalHtml(waveformData, audioDataName, waveformJs, controlsJs, timestretchJs, fadesJs, fontsCss);

    // Serve from a file: URL — the audio subresource sits in the same directory.
    const htmlPath = path.join(tempDir, `audio-editor-ui-${stamp}.html`);
    await fs.writeFile(htmlPath, html, 'utf-8');

    let resultStr: string;
    try {
      resultStr = await context.ui.showModalDialog(pathToFileURL(htmlPath).href, 960, 620);
    } finally {
      fs.unlink(htmlPath).catch(() => {});
      fs.unlink(audioDataPath).catch(() => {});
    }

    let result: ProcessResult;
    try {
      result = JSON.parse(resultStr) as ProcessResult;
    } catch {
      // Modal was dismissed without posting a result (e.g. OS-level close) — treat as cancel.
      return;
    }

    if (result.cancelled) return;

    await context.ui.withinProgressDialog('Clip Tool', { progress: 0 }, async (update) => {
      await update('Processing audio…', 10);

      // Write into the sandbox-writable temp directory; importIntoProject then
      // copies the result into the Live project where Live manages it.
      const outputDir = context.environment.tempDirectory ?? path.dirname(renderedPath);
      // A rename uses the exact name; otherwise the original stem + _edited_NNN.
      const customName = result.outputName
        ? result.outputName.replace(/[\/\\:*?"<>|\x00-\x1f]/g, '_').trim()
        : '';
      const stem = path.basename(displayPath, path.extname(displayPath));
      const pickOutputPath = (dir: string) =>
        customName ? uniqueNamedPath(dir, customName) : nextOutputPath(dir, stem);
      const outputPath = await pickOutputPath(outputDir);

      const opts: ProcessOptions = {
        inputPath: renderedPath,
        outputPath,
        gain_dB: result.gain_dB,
        channel: result.channel,
        crop: result.crop,
        trimStart: result.trimStart,
        trimEnd: result.trimEnd,
        stretchRatio: result.stretchRatio,
        stretchCyclic: result.stretchCyclic,
        fadeIn: result.fadeIn,
        fadeOut: result.fadeOut,
        removeDc: result.removeDc,
        // Default the guard on when the field is absent (older UI / safety).
        preventClipping: result.preventClipping ?? true,
        pitchSemitones: result.pitchSemitones,
        stretchWindowMs: result.stretchWindowMs,
        stretchTransient: result.stretchTransient,
      };

      let lastUpdateTime = Date.now();
      let lastReportedProgress = 0;
      await processAudio(opts, (progress) => {
        const now = Date.now();
        // Only update if progress jumped significantly or 100ms passed
        if (progress - lastReportedProgress > 0.05 || now - lastUpdateTime >= 100) {
          lastUpdateTime = now;
          lastReportedProgress = progress;
          const pct = Math.round(10 + progress * 60);
          // Fire update without blocking — let Ableton queue it
          void update(`Processing audio… ${pct}%`, pct);
        }
      });

      await update('Importing into project…', 70);

      // Live's importIntoProject writes the file into the project's
      // Samples/Imported/ folder and returns its final path. The original sample
      // is never written to; every edit is a brand-new file.
      const finalPath = await context.resources.importIntoProject(outputPath);

      // Simpler: drop the processed sample onto a Simpler on a new MIDI track.
      if (result.mode === 'simpler') {
        await update('Creating Simpler track…', 85);
        const song = context.application.song;
        const newTrack = await song.createMidiTrack();
        const device = await newTrack.insertDevice('Simpler', 0);
        const simpler = device as unknown as Simpler<'1.0.0'>;
        await simpler.replaceSample(finalPath);
        // Name the track after the sample for clarity.
        newTrack.name = path.basename(finalPath, path.extname(finalPath));
        await update('Done', 100);
        return;
      }

      const isCopy = result.mode === 'copy';
      await update(isCopy ? 'Adding copy to arrangement…' : 'Replacing clip…', 85);

      // renderPreFxAudio already printed the source clip's *warped playback* to a
      // plain WAV at the project tempo — any warp is baked in and the audio is 1:1
      // with arrangement time. So the replacement must be imported UNWARPED. Passing
      // the source clip's `warping` here (true for a warped clip) makes Live Auto-Warp
      // the already-printed file against a guessed tempo, double-warping it — the cause
      // of the "tempo messed up" and stutter/jitter reports (issue #1).
      //
      // `duration` is omitted so Live uses the processed file's natural length at the
      // current tempo. That exactly matches the rendered material — including any crop
      // or stretch we applied — without assuming the original clip played the whole file.
      const promises = context.withinTransaction(() => {
        const clearP = isCopy ? null : track.clearClipsInRange(startTime, endTime);
        const createP = track.createAudioClip({
          filePath: finalPath,
          // Copy lands immediately after the original clip on the same track.
          startTime: isCopy ? endTime : startTime,
          isWarped: false,
        });
        return [clearP, createP] as const;
      });
      await Promise.all(promises.filter((p): p is NonNullable<typeof p> => p !== null));

      await update('Done', 100);
    });
  }

  context.commands.registerCommand('audioeditor.open', (arg: unknown) => {
    handleAudioEdit(arg as Handle).catch((e) => console.error('[Audio Editor]', e));
  });
}
