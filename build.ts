import * as esbuild from 'esbuild';
import * as fs from 'node:fs/promises';

await esbuild.build({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: 'dist/extension.cjs',
  loader: {
    '.html': 'text',
  },
  sourcemap: true,
});

await fs.mkdir('dist/webview', { recursive: true });
await fs.copyFile('src/webview/waveform.js', 'dist/webview/waveform.js');
await fs.copyFile('src/webview/controls.js', 'dist/webview/controls.js');

// Inline Inter (woff2) as base64 @font-face so the self-contained modal needs
// no external font files. The extension injects this into the modal HTML at the
// FONT_FACE_PLACEHOLDER marker.
const interDir = 'node_modules/@fontsource/inter/files';
const [inter400, inter600] = await Promise.all([
  fs.readFile(`${interDir}/inter-latin-400-normal.woff2`),
  fs.readFile(`${interDir}/inter-latin-600-normal.woff2`),
]);
const fontFace = (weight: number, b64: string) =>
  `@font-face{font-family:'Inter';font-style:normal;font-weight:${weight};`
  + `font-display:swap;src:url(data:font/woff2;base64,${b64}) format('woff2');}`;
await fs.writeFile(
  'dist/webview/fonts.css',
  `${fontFace(400, inter400.toString('base64'))}\n${fontFace(600, inter600.toString('base64'))}\n`,
);

// Timestretch is shared DSP: TypeScript for the Node processor, compiled
// here to a browser global for the editor webview.
await esbuild.build({
  entryPoints: ['src/timestretch.ts'],
  bundle: true,
  format: 'iife',
  globalName: 'TimeStretch',
  outfile: 'dist/webview/timestretch.js',
});

// Fade curves are shared the same way.
await esbuild.build({
  entryPoints: ['src/fades.ts'],
  bundle: true,
  format: 'iife',
  globalName: 'Fades',
  outfile: 'dist/webview/fades.js',
});

console.log('Build complete → dist/extension.cjs');
