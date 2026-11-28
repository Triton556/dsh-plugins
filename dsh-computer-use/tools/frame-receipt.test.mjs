import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFrameStore, pointerLine, pointerReceipt, readCapture } from './frame-receipt.mjs';

const signature = 'A'.repeat(64);
const source = { path: 'C:\\My Files\\a.png', left: 120, top: 80, width: 444, height: 2000, fingerprint: signature };
const window = 'Fixture A';
const drag = 'computer_drag';
const click = 'computer_click';
const args = { window, x: 520, y: 1654 };
const id = text => text.match(/Frame ID: (\S+)/)[1];

test('accepts a bounded clamped crop and no arbitrary transport output', () => {
  assert.deepEqual(readCapture(source.path + '\r\n[cua-frame] 120 80 444 2000 ' + signature), source);
  for (const text of ['C:\\a.png', 'path\n[cua-frame] 0 0 0 10 ' + signature,
    'extra\npath\n[cua-frame] 0 0 10 10 ' + signature, 'path\n[cua-frame] 0 0 10 10 tamper']) {
    assert.equal(readCapture(text), null);
  }
});

test('shows independently measured attachment axes and requires both drag endpoints inside source', () => {
  const frames = createFrameStore();
  const receipt = frames.issue(source, { window }, { width: 56, height: 256 });
  assert.match(receipt, /sourceWidth\/56.*sourceHeight\/256/);
  const frame_id = id(receipt);
  assert.match(frames.take({ ...args, x2: 564, y2: 1000, frame_id }, drag).error, /^POINT_OUTSIDE_FRAME/);
  assert.match(frames.take({ ...args, window: 'Fixture B', frame_id }, click).error, /^FRAME_TARGET_MISMATCH/);
  assert.match(frames.take({ ...args, window: undefined, frame_id }, click).error, /^FRAME_TARGET_MISMATCH/);
  assert.equal(frames.take({ ...args, frame_id }, click).frame.fingerprint, signature);
  assert.match(frames.take({ ...args, frame_id }, click).error, /^STALE_FRAME/);
});

test('rejects a revoked, superseded, expired, or different-context observation', () => {
  let time = 0;
  const frames = createFrameStore(() => time);
  const make = () => id(frames.issue(source, { window }));
  const one = make(), two = make();
  assert.match(frames.take({ ...args, frame_id: one }, click).error, /^STALE_FRAME/);
  assert.match(createFrameStore().take({ ...args, frame_id: two }, click).error, /^STALE_FRAME/);
  time = 60000;
  assert.match(frames.take({ ...args, frame_id: two }, click).error, /^STALE_FRAME/);
  const three = make();
  frames.clear();
  assert.match(frames.take({ ...args, frame_id: three }, click).error, /^STALE_FRAME/);
});

test('keeps screenshot metadata and status honest without leaking markers into the rendered result', () => {
  const prefix = { ...args, window: 'Alpha\nBeta' };
  const completed = pointerReceipt(click, prefix, { ok: true, text: pointerLine + '\nclicked' }, 'started');
  assert.match(completed.text, /^Computer Use · Click · Alpha Beta · Foreground\nInput sent. App response not verified./);
  assert.doesNotMatch(completed.text, /\[cua-pointer\]/);
  assert.match(pointerReceipt(click, args, { ok: false, text: 'STALE_FRAME' }, 'not-sent').text, /No pointer input sent/);
  assert.match(pointerReceipt(drag, args, { ok: false, text: 'STOPPED' }, 'started').text, /delivery is uncertain/);
  assert.match(pointerReceipt(drag, args, { ok: true, text: 'legacy' }, 'unknown').text, /delivery is uncertain/);
});
