import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const frameLine = /^\[cua-frame\] (\d+) (\d+) (\d+) (\d+) ([A-F0-9]{64})$/;
export const pointerLine = '[cua-pointer] dispatching';
export const guardedPointer = name => name === 'computer_click' || name === 'computer_drag';
const int = Number.isSafeInteger;

export function readCapture(text) {
  const lines = text.trimEnd().split(/\r?\n/);
  const raw = lines.pop()?.match(frameLine);
  if (!raw || lines.length !== 1 || !lines[0].trim()) return null;
  const [left, top, width, height] = raw.slice(1, 5).map(Number);
  if (![left, top, width, height, left + width, top + height].every(int) ||
      width < 1 || height < 1) return null;
  return { path: lines[0], left, top, width, height, fingerprint: raw[5] };
}

// A receipt is geometry evidence, not a consent mechanism.
export function createFrameStore(now = () => performance.now()) {
  const frames = new Map();
  return {
    issue(capture, args, image) {
      for (const [id, frame] of frames) {
        if (frame.expires <= now() || (frame.window === args.window && frame.pid === args.pid)) frames.delete(id);
      }
      const id = randomUUID();
      if (frames.size >= 32) frames.delete(frames.keys().next().value);
      const width = int(image?.width) && image.width > 0 ? image.width : undefined;
      const height = int(image?.height) && image.height > 0 ? image.height : undefined;
      frames.set(id, { ...capture, window: args.window, pid: args.pid, expires: now() + 60_000 });
      return [
        'Frame ID: ' + id + ' (single-use; 60 s; window geometry only)',
        'Source crop (window-relative): ' + [capture.left, capture.top, capture.width, capture.height].join(', ') + ' [left, top, width, height]',
        width && height
          ? 'Attachment: ' + width + '×' + height + '. X=left+floor((x+0.5)*sourceWidth/' + width +
            '), Y=top+floor((y+0.5)*sourceHeight/' + height + '). Pass window-relative coordinates and frame_id.'
          : 'Attachment dimensions unavailable. Use original PNG pixels plus the crop offset.',
      ].join('\n');
    },
    take(args, name) {
      const frame = frames.get(args.frame_id);
      if (!frame || frame.expires <= now()) {
        frames.delete(args.frame_id);
        return { error: 'STALE_FRAME: unknown, consumed or expired frame; take a new window screenshot.' };
      }
      if ((!args.window && !args.pid) || args.window !== frame.window || args.pid !== frame.pid) {
        return { error: 'FRAME_TARGET_MISMATCH: use the exact window/pid supplied to the screenshot.' };
      }
      const inside = (x, y) => int(x) && int(y) && x >= frame.left && x < frame.left + frame.width &&
        y >= frame.top && y < frame.top + frame.height;
      if (!inside(args.x, args.y) || (name === 'computer_drag' && !inside(args.x2, args.y2))) {
        return { error: 'POINT_OUTSIDE_FRAME: convert the screenshot pixels to window coordinates.' };
      }
      frames.delete(args.frame_id);
      return { frame };
    },
    clear() { frames.clear(); }
  };
}

export function pointerReceipt(name, args, result, delivery) {
  const target = String(args.window || (args.pid ? 'PID ' + args.pid : 'Entire desktop'))
    .replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim().slice(0, 100);
  const operation = name === 'computer_drag' ? 'Drag' : args.double ? 'Double click' : 'Click';
  const status = delivery === 'not-sent' ? 'No pointer input sent.'
    : delivery === 'started' && result.ok ? 'Input sent. App response not verified.'
    : 'Input delivery is uncertain. Inspect the app before repeating.';
  return {
    ...result,
    text: ['Computer Use · ' + operation + ' · ' + target + ' · Foreground', status,
      args.frame_id !== undefined ? 'Window screenshot reference supplied.' : '',
      String(result.text || '').split(/\r?\n/).filter(line => line !== pointerLine).join('\n'),
    ].filter(Boolean).join('\n')
  };
}
