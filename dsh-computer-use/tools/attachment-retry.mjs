// Exercise registered computer_shot with real PNG/FFmpeg and a strict fake
// attachment store. Replace only the native capture boundary for portability.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const stub = new URL('./dsh-tools-stub.mjs', import.meta.url).href;
const engine = 'data:text/javascript,export const engine=async ({Path})=>({ok:true,text:Path});';
registerHooks({
  resolve(spec, context, next) {
    if (spec === '@deepseek-ai/dsh-tools') return { url: stub, shortCircuit: true };
    if (spec === './tools/engine.mjs') return { url: engine, shortCircuit: true };
    return next(spec, context);
  },
});
const { apply } = await import('../index.js');
const root = mkdtempSync(join(tmpdir(), 'cua-attachment-test-'));

async function verify(label, dims, imageLimits, rejection, savedDims, expectImage = true) {
  const path = join(root, label + '.png');
  execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i',
    `color=0x123456:size=${dims.join('x')}`, '-frames:v', '1', '-threads', '1', path]);
  const original = readFileSync(path);
  const loads = [], definitions = [], effects = [];
  const context = {
    get(name) {
      if (name === 'tools') return { register: (item) => { definitions.push(item); return () => {}; } };
      if (name === 'attachments') return {
        imageLimits,
        async saveImage({ data, mediaType }) {
          assert.equal(mediaType, 'image/png');
          const width = data.readUInt32BE(16), height = data.readUInt32BE(20);
          loads.push([width, height]);
          if (rejection && loads.length === 1) throw new Error(rejection);
          if (width > imageLimits.maxImageDimension || height > imageLimits.maxImageDimension) throw new Error('DIMENSION_TOO_LARGE');
          if (width * height > imageLimits.maxImagePixels) throw new Error('TOO_MANY_PIXELS');
          return { attachmentId: label, width, height, bytes: data.length, mediaType };
        },
      };
      return undefined;
    },
    effect(callback) { effects.push(callback); return () => {}; },
    inject(services, callback) { if (services.includes('tools')) callback(context); return () => {}; },
  };
  apply(context, {});
  for (const effect of effects) await effect();
  const shot = definitions.find(t => t.name === 'computer_shot');
  assert(shot, 'computer_shot must register');
  const result = await shot.execute({ window: 'Fake fixture', path });
  assert.equal(result.ok, true);
  assert.equal(result.text, path);
  assert.deepEqual(readFileSync(path), original, 'retry must not overwrite the original');
  if (expectImage) {
    assert(result.image, 'the valid image must be attached');
    assert.deepEqual([result.image.width, result.image.height], savedDims);
    assert(shot.output.render({}, result).some(block => block.type === 'image'));
    assert.deepEqual(loads, rejection ? [dims, savedDims] : [dims]);
  } else {
    assert.equal(result.image, undefined);
    assert.deepEqual(loads, [dims], 'do not retry an unrelated store failure');
  }
}
try {
  const side = { maxImageDimension: 256, maxImagePixels: 1_000_000 };
  await verify('tall', [44, 600], side, 'DIMENSION_TOO_LARGE', [18, 256]);
  await verify('wide', [600, 44], side, 'DIMENSION_TOO_LARGE', [256, 18]);
  await verify('pixel-budget', [400, 400], { ...side, maxImageDimension: 8192, maxImagePixels: 10_000 }, 'TOO_MANY_PIXELS', [100, 100]);
  await verify('byte-retry', [80, 80], side, 'TOO_LARGE', [70, 70]);
  await verify('success-unchanged', [80, 80], side, null, [80, 80]);
  await verify('no-retry', [80, 80], side, 'STORE_UNAVAILABLE', null, false);
  console.log('PASS: registered screenshot attachment retry honors both sides, area cap and non-limit errors');
} finally {
  rmSync(root, { recursive: true, force: true });
}
