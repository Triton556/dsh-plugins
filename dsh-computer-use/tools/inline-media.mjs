// Verify inline media without the host: a screenshot must come back with an
// attachment reference, and render() must emit an image block (the mechanism the
// core read_image tool uses).
//
// Usage: node tools/inline-media.mjs
import { registerHooks } from 'node:module';
import { writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const STUB = new URL('./dsh-tools-stub.mjs', import.meta.url).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@deepseek-ai/dsh-tools') return { url: STUB, shortCircuit: true };
    return nextResolve(specifier, context);
  }
});
const { apply } = await import('../index.js');

let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) { console.log(`  ok   ${label}`); return; }
  failures += 1;
  console.log(`  FAIL ${label}${detail ? ` :: ${String(detail).slice(0, 220)}` : ''}`);
};

const dir = join(tmpdir(), 'dsh-inline-media');
mkdirSync(dir, { recursive: true });
const png = join(dir, 'probe.png');
writeFileSync(png, Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAF0lEQVR42mP8z8Dwn4GBgYGJgYGBgYEBAA8kAgHk1k6ZAAAAAElFTkSuQmCC',
  'base64'
));

// A cordis-shaped context that records registrations and can buffer effects.
function makeContext({ attachments } = {}) {
  const registered = [];
  const effects = [];
  const injections = [];
  const ctx = {
    get(name) {
      if (name === 'tools') return { register: (definition) => { registered.push(definition); return () => {}; } };
      if (name === 'attachments') return attachments;
      return undefined;
    },
    effect(callback, label) { effects.push({ callback, label }); return () => {}; },
    inject(services, callback) { injections.push({ services, callback }); return () => {}; }
  };
  return { ctx, registered, effects, injections };
}

const saved = [];
const attachmentStore = {
  imageLimits: { mediaTypes: ['image/png'], maxImageBytes: 10_000_000, maxMessageImageBytes: 10_000_000, maxImageDimension: 8192, maxImagePixels: 40_000_000 },
  async saveImage(input) {
    saved.push(input);
    return { attachmentId: 'att_test_1', mediaType: input.mediaType, bytes: input.data.length, width: 4, height: 4, name: 'probe.png' };
  }
};

const wired = makeContext({ attachments: attachmentStore });
apply(wired.ctx, {});
wired.injections[0].callback(wired.ctx);
await wired.effects[0].callback();
await new Promise((resolve) => setTimeout(resolve, 300));

const shot = wired.registered.find((tool) => tool.name === 'computer_shot');
const video = wired.registered.find((tool) => tool.name === 'computer_video');
check('tools registered', wired.registered.length === 20, `${wired.registered.length}`);
check('computer_shot registered', !!shot);
check('computer_video registered', !!video);

// Drive the real engine: a screenshot of the DSH window writes a PNG, and the
// tool must attach it.
let result = null;
try {
  result = await shot.execute({ window: 'DeepSeek Harness', method: 'print', path: png });
} catch (error) {
  console.log('  note: engine call failed ::', String(error.message).slice(0, 120));
}
check('screenshot carries an attachment', !!(result && result.image && result.image.attachmentId), JSON.stringify(result && { ok: result.ok, keys: Object.keys(result) }));
check('attachment went through the store', saved.length >= 1, `saved=${saved.length}`);

const value = result && result.image ? result : { text: 'x', image: { attachmentId: 'att_test_1', mediaType: 'image/png', bytes: 1, width: 4, height: 4 } };
const blocks = shot.output.render({}, value);
const imageBlock = blocks.find((block) => block.type === 'image');
check('render() emits an image block', !!imageBlock);
check('image block references the attachment', !!imageBlock && imageBlock.attachment.attachmentId === 'att_test_1');
check('text block stays first', blocks[0] && blocks[0].type === 'text');

// Without an attachment service the tool must still answer with the path only.
const plain = makeContext();
apply(plain.ctx, {});
plain.injections[0].callback(plain.ctx);
await plain.effects[0].callback();
await new Promise((resolve) => setTimeout(resolve, 200));
const plainShot = plain.registered.find((tool) => tool.name === 'computer_shot');
let plainResult = null;
try { plainResult = await plainShot.execute({ window: 'DeepSeek Harness', method: 'print', path: png }); } catch (error) {}
check('no attachment service -> no image field', !plainResult || plainResult.image === undefined, JSON.stringify(plainResult && Object.keys(plainResult)));

console.log(failures ? `FAIL: ${failures}` : 'PASS: inline media wiring verified');
process.exit(failures ? 1 : 0);