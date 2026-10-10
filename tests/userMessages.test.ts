import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_PREVIEW_BYTES, previewTooLarge, largeClipNotice, describeError, buildMessageHtml,
} from '../src/userMessages.ts';

test('preview limit: at the limit is fine, one byte over is not', () => {
  assert.equal(previewTooLarge(MAX_PREVIEW_BYTES), false);
  assert.equal(previewTooLarge(MAX_PREVIEW_BYTES + 1), true);
  // The reviewed worst case: a ~400 MB render must not be sent as base64.
  assert.equal(previewTooLarge(400 * 1024 * 1024), true);
});

test('the large-clip notice says how big the clip is and what still works', () => {
  const text = largeClipNotice(400 * 1024 * 1024);
  assert.match(text, /400 MB/);
  assert.match(text, /128 MB preview limit/);
  assert.match(text, /Process, Copy and Simpler buttons still work/);
});

test('describeError names the stage and keeps the reason', () => {
  const { title, message } = describeError('import the result into your project', new Error('Disk full'));
  assert.equal(title, 'Clip Tool could not import the result into your project');
  assert.equal(message, 'Disk full');
});

test('describeError explains a non-WAV render', () => {
  const { message } = describeError('open the editor', new Error('Not a WAV file (whatever)'));
  assert.match(message, /Record File Type to WAV/);
});

test('describeError copes with an error that has no message', () => {
  assert.equal(describeError('render the clip', undefined).message, 'Live did not give a reason.');
  assert.equal(describeError('render the clip', 'plain string').message, 'plain string');
});

test('the message dialog escapes its text and closes with close_and_send', () => {
  const html = buildMessageHtml('Clip Tool could not <b>x</b>', 'a "quote" & </script>');
  assert.ok(!html.includes('<b>x</b>'));
  assert.ok(html.includes('&lt;b&gt;x&lt;/b&gt;'));
  assert.ok(html.includes('a &quot;quote&quot; &amp; &lt;/script&gt;'));
  assert.match(html, /close_and_send/);
});
