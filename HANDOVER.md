# Handover: Clip Tool

**Updated:** 2026-10-10
**Branch:** `main`, in step with `origin/main`
**Released:** v1.2.0 on GitHub (Latest), with `clip-tool.ablx` attached.
**State:** Tested in Live on macOS before release. 103 unit tests passing
(`npm test`). Targets Ableton Live 12 with Extensions support on macOS and
Windows; Live does not run on Linux, which is only used for development.

## What 1.2.0 changed

v1.1.0 was tagged but never published, so the 1.2.0 release notes cover
everything since v1.0.3. The main pieces:

- **Time-stretch rebuilt** (`src/timestretch.ts`). Grains never read past the end
  (no fade-out on stretched or pitched-up clips). Transient preservation finds
  attacks from short-term level jumps and plays each one through once at the
  original speed. Pitch-up resamples first, so no buffer is larger than the
  output. A coarse-to-fine search over a padded guide makes it about 10x faster.
- **Preview runs the render's code.** `src/dsp.ts` holds crop, channel, DC,
  gain, fades and waveform peaks, compiled to the `Dsp` global for the webview
  as well as used by `src/processor.ts`.
- **Render rules** (decided 10 Oct): a narrowed selection crops on Process,
  Copy and Simpler; with Loop on, the loop region is what plays, carries the
  fades and is rendered as a cycle (`src/editRange.ts`, `waveform.renderStart`
  and `renderEnd`).
- **Clip placement** (`src/placement.ts`): a result that fits before the next
  clip is shown in full; one that would run into a neighbour keeps the original
  clip's size, with the rest left in the file as a tail. Never overlaps. A
  cropped Process lands where its audio was, converted at the song tempo.
- **Cancel** in the progress dialog stops processing (`ProcessCancelled`).
- **Clear** button and Delete/Backspace remove the loop, then the selection.
- Windows-safe output names (`sanitizeOutputName`), `$` in sample names no
  longer breaks the page, HiDPI canvas with a cached layer, FFT pitch detection,
  typed-array WAV read and write.

## Release routine

1. Bump the version in `package.json`, `manifest.json` and `src/webview/index.html`
   (the `v…` label under the logo and the logo's `aria-label`).
2. `npm test`, then `npm run build` and
   `npx extensions-cli package -o dist-release/clip-tool.ablx -i dist/webview`.
   (`dist-release/` is excluded from git; `npm run package` writes the root
   `clip-tool.ablx`, which is also ignored.)
3. Test the `.ablx` in Live, on macOS and ideally Windows.
4. Screenshots: `npm run preview` builds `preview/out/index.html` with a
   synthesised break. The README shots are 1180x560 at 2x, taken headless with
   the editor driven into each state; crops are the header row (controls), the
   Bars menu (dropdown), the logo and channel panel, and the action row.
5. Merge to `main`, tag `vX.Y.Z`, push, create the GitHub release with the notes
   and the `.ablx`.

## Open

- **liveextensions.co** lists Clip Tool (by Forty Miles West) and serves its
  own copy of the download, still the old build. Needs the 1.2.0 `.ablx` and
  new screenshots; no contact address found on the site yet.
- **Whole-file processing**: run one edit on every clip that shares a sample
  (asked for in issue #1, for comped bounces). Not started.
- **Crop placement under tempo automation** uses the current song tempo, so it
  is close rather than exact when the tempo changes within the clip.
