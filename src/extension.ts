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
  pitchSemitones?: number;
  stretchWindowMs?: number;
  stretchTransient?: number;
  /** Renamed sample (stem, no extension); blank/absent keeps the original name. */
  outputName?: string;
}

function buildModalHtml(
  waveformData: object,
  audioB64: string,
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
      // Must be window properties: top-level const in a classic script is not
      // attached to window, and controls.js reads them from window.
      // base64 is a safe charset (no quotes/backslashes), so it needs no escaping.
      `window.WAVEFORM_DATA = ${waveformJson};\n`
        + `window.AUDIO_WAV_B64 = "${audioB64}";`
    )
    .replace('<script src="timestretch.js"></script>', `<script>\n${timestretchJs}\n</script>`)
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
    const isWarped = clip.warping;

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

    // Embed the rendered audio so the dialog can preview edits via Web Audio.
    const audioB64 = (await fs.readFile(renderedPath)).toString('base64');
    const html = buildModalHtml(waveformData, audioB64, waveformJs, controlsJs, timestretchJs, fadesJs, fontsCss);

    // Serve from a file: URL — with audio embedded the page is megabytes,
    // far beyond what is sane to push through a data: URL.
    const tempDir = context.environment.tempDirectory ?? path.dirname(renderedPath);
    const htmlPath = path.join(tempDir, `audio-editor-ui-${Date.now()}.html`);
    await fs.writeFile(htmlPath, html, 'utf-8');

    let resultStr: string;
    try {
      resultStr = await context.ui.showModalDialog(pathToFileURL(htmlPath).href, 960, 620);
    } finally {
      fs.unlink(htmlPath).catch(() => {});
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
        pitchSemitones: result.pitchSemitones,
        stretchWindowMs: result.stretchWindowMs,
        stretchTransient: result.stretchTransient,
      };

      await processAudio(opts);

      await update('Importing into project…', 70);

      const imported = await context.resources.importIntoProject(outputPath);

      // Park processed renders in the project's Samples/Processed folder,
      // clearly separated from raw imports. The path importIntoProject returns
      // reveals the project location ({project}/Samples/Imported/...). The
      // original sample is never written to — every edit is a new file.
      let finalPath = imported;
      try {
        const importDir = path.dirname(imported);
        const samplesRoot = path.basename(importDir).toLowerCase() === 'imported'
          ? path.dirname(importDir)
          : importDir;
        const processedDir = path.join(samplesRoot, 'Processed');
        await fs.mkdir(processedDir, { recursive: true });
        // Reserve a unique name in the Processed dir itself — the temp-dir
        // reservation does not protect against a same-named file left by an
        // earlier session, which a plain rename would silently overwrite.
        const target = await pickOutputPath(processedDir);
        try {
          await fs.rename(imported, target);
          finalPath = target;
        } catch (err) {
          await fs.unlink(target).catch(() => {}); // drop the empty placeholder
          throw err;
        }
      } catch {
        // Sandbox may disallow writing there — keep Live's import location.
      }

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

      // Cropping shortens the rendered audio; scale the new clip's arrangement
      // length by the cropped fraction so it covers just the rendered material.
      // (Assumes the original clip plays the whole file — Live adjusts if warped.)
      const croppedFraction = result.crop && waveformData.duration > 0
        ? (result.trimEnd - result.trimStart) / waveformData.duration
        : 1;
      // Stretching changes the audio length; scale arrangement time with it.
      const stretchRatio = result.stretchRatio && result.stretchRatio > 0 ? result.stretchRatio : 1;
      const newDuration = (endTime - startTime) * croppedFraction * stretchRatio;

      // withinTransaction fn must return synchronously. clearClipsInRange and createAudioClip
      // return Promises; collect them here and await outside the transaction boundary.
      const promises = context.withinTransaction(() => {
        const clearP = isCopy ? null : track.clearClipsInRange(startTime, endTime);
        const createP = track.createAudioClip({
          filePath: finalPath,
          // Copy lands immediately after the original clip on the same track.
          startTime: isCopy ? endTime : startTime,
          duration: isCopy ? newDuration : (endTime - startTime) * stretchRatio,
          isWarped,
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
