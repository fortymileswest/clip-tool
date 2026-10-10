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

// Inline the brand faces (woff2) as base64 @font-face so the self-contained
// modal needs no external font files and never touches the network: IBM Plex
// Sans for the interface, IBM Plex Mono for labels and numbers, Michroma for
// the wordmark only. The extension injects this into the modal HTML at the
// FONT_FACE_PLACEHOLDER marker.
const fonts: Array<[family: string, pkg: string, file: string, weight: number]> = [
  ['IBM Plex Sans', 'ibm-plex-sans', 'ibm-plex-sans-latin-400-normal', 400],
  ['IBM Plex Sans', 'ibm-plex-sans', 'ibm-plex-sans-latin-500-normal', 500],
  ['IBM Plex Mono', 'ibm-plex-mono', 'ibm-plex-mono-latin-400-normal', 400],
  ['IBM Plex Mono', 'ibm-plex-mono', 'ibm-plex-mono-latin-500-normal', 500],
  ['IBM Plex Mono', 'ibm-plex-mono', 'ibm-plex-mono-latin-600-normal', 600],
  ['Michroma', 'michroma', 'michroma-latin-400-normal', 400],
];
const fontFaces = await Promise.all(fonts.map(async ([family, pkg, file, weight]) => {
  const b64 = (await fs.readFile(`node_modules/@fontsource/${pkg}/files/${file}.woff2`)).toString('base64');
  return `@font-face{font-family:'${family}';font-style:normal;font-weight:${weight};`
    + `font-display:block;src:url(data:font/woff2;base64,${b64}) format('woff2');}`;
}));
await fs.writeFile('dist/webview/fonts.css', `${fontFaces.join('\n')}\n`);

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

// The render range shared by the editor's Process/Copy/Simpler buttons.
await esbuild.build({
  entryPoints: ['src/editRange.ts'],
  bundle: true,
  format: 'iife',
  globalName: 'EditRange',
  outfile: 'dist/webview/editrange.js',
});

console.log('Build complete → dist/extension.cjs');
