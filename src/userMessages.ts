// What the user sees when something goes wrong. The SDK has no alert or
// notification call, so a failure is shown in a small modal dialog of our own
// (built here as plain HTML, closed with the same close_and_send message the
// editor uses). Kept free of SDK imports so it can be tested directly.

/** Largest rendered clip whose audio is sent to the editor for preview. The
 *  bytes travel as one base64 string (a third larger again) and are decoded to
 *  32-bit float in the webview, so a few hundred MB would exhaust memory or
 *  exceed the JavaScript string limit. 128 MB is about 11 minutes of 32-bit
 *  float stereo at 48 kHz, or about 15 minutes at 24-bit. */
export const MAX_PREVIEW_BYTES = 128 * 1024 * 1024;

export function previewTooLarge(byteLength: number): boolean {
  return byteLength > MAX_PREVIEW_BYTES;
}

/** Shown in the editor when the clip is over MAX_PREVIEW_BYTES. */
export function largeClipNotice(byteLength: number): string {
  const mb = Math.round(byteLength / (1024 * 1024));
  const limit = Math.round(MAX_PREVIEW_BYTES / (1024 * 1024));
  return `This clip is ${mb} MB of audio, over the ${limit} MB preview limit, so the editor shows the waveform outline only. `
    + 'Preview, sample zoom, ZC, Trim to Selection and key/tempo detection are off. '
    + 'Gain, channel, fades, pitch, stretch and the Process, Copy and Simpler buttons still work on the full clip.';
}

/** The stage a failure happened in, phrased to follow "Clip Tool could not …". */
export type Stage =
  | 'render the clip'
  | 'open the editor'
  | 'process the audio'
  | 'import the result into your project'
  | 'add the result to your set';

/** Turns an error into one plain sentence for the user. */
export function describeError(stage: Stage, err: unknown): { title: string; message: string } {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  let detail = raw.trim();
  if (/^Not a WAV file/.test(detail)) {
    detail = 'Live rendered the clip in a format other than WAV. Set Record File Type to WAV in Live\'s Settings (Record, Warp & Launch) and try again.';
  } else if (/^Unsupported WAV format/.test(detail)) {
    detail = `${detail}. Check the bit depth set under Record File Type in Live's Settings.`;
  } else if (!detail) {
    detail = 'Live did not give a reason.';
  }
  return { title: `Clip Tool could not ${stage}`, message: detail };
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

/** A self-contained message dialog in the editor's colours. */
export function buildMessageHtml(title: string, message: string, fontsCss = ''): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Clip Tool</title>
<style>
${fontsCss}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'IBM Plex Sans',system-ui,sans-serif;font-size:13px;line-height:1.45;background:#5c5c5c;color:#f2f2f0;
  height:100vh;display:flex;flex-direction:column;user-select:none}
main{flex:1;margin:12px 12px 0;padding:14px 16px;background:#050506;border:1px solid #111;border-top:2px solid #ff4f6a;border-radius:3px;overflow:auto}
h1{font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace;font-size:11px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:#ff4f6a;margin-bottom:8px}
p{color:#ececea;user-select:text;word-wrap:break-word}
footer{display:flex;justify-content:flex-end;padding:10px 12px}
button{font-family:'IBM Plex Mono',ui-monospace,Menlo,Consolas,monospace;font-size:11px;letter-spacing:.08em;text-transform:uppercase;
  height:28px;padding:0 18px;background:#202020;color:#f2f2f0;border:1px solid #111;border-radius:3px;cursor:pointer}
button:hover{background:#2a2a2a}
button:focus-visible{outline:1px solid #27d0a8;outline-offset:1px}
</style></head>
<body>
<main role="alert"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></main>
<footer><button id="ok" autofocus>OK</button></footer>
<script>
function closeDialog(){var m={method:'close_and_send',params:['ok']};
  if(window.webkit&&window.webkit.messageHandlers&&window.webkit.messageHandlers.live){window.webkit.messageHandlers.live.postMessage(m);}
  else if(window.chrome&&window.chrome.webview){window.chrome.webview.postMessage(m);}}
document.getElementById('ok').addEventListener('click',closeDialog);
document.addEventListener('keydown',function(e){if(e.key==='Enter'||e.key==='Escape')closeDialog();});
</script>
</body></html>`;
}
