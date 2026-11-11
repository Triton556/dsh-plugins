// Staged v1. Pure, inert on import. No model-supplied session/workspace authority.
export const VERSION = 1;
export const LIMITS = Object.freeze({ bytes: 65536, captureBytes: 1500000, inputBytes: 16384, text: 4096, nodes: 50, selector: 256, timeout: 15000, queue: 32, heartbeat: 6000 });
export class ToolError extends Error {
  constructor(code, message, effect = 'none') { super(message); this.code = code; this.effect = effect; }
}
export const fail = (code, message, effect) => { throw new ToolError(code, message, effect); };
export const jsonBytes = value => new TextEncoder().encode(JSON.stringify(value)).byteLength;
export const object = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const s = { type: 'string' }, n = { type: 'number' }, b = { type: 'boolean' };
const en = (...values) => ({ type: 'string', enum: values });
const target = object({ tabId: s, documentId: s }, ['tabId', 'documentId']);
const point = object({ x: n, y: n }, ['x', 'y']);
const move = object({ selector: s, hash: s, scroll: point });
const action = { oneOf: [
  object({ kind: { const: 'click', type: 'string' }, selector: s, submit: b }, ['kind', 'selector']),
  object({ kind: { const: 'type', type: 'string' }, selector: s, text: s, mode: en('replace', 'append') }, ['kind', 'selector', 'text']),
  object({ kind: { const: 'select', type: 'string' }, selector: s, values: { type: 'array', items: s } }, ['kind', 'selector', 'values']),
  object({ kind: { const: 'focus', type: 'string' }, selector: s }, ['kind', 'selector']),
  object({ kind: { const: 'press', type: 'string' }, selector: s, key: en('Enter', ' ', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'), submit: b }, ['kind', 'selector', 'key']),
  object({ kind: { const: 'scroll', type: 'string' }, selector: s, x: n, y: n }, ['kind', 'selector', 'x', 'y'])
] };
const spec = (name, description, properties, required = []) => ({ name: 'dsh_' + name, description, input: object(properties, required) });
export const CATALOG = [
  spec('artifact_list', 'List HTML artifacts of the current session.', { limit: n }),
  spec('artifact_open', 'Open an artifact in the right panel without taking system focus.', { path: s, placement: en('current', 'new'), reload: b, focus: b, ...move.properties }, ['path']),
  spec('artifact_tabs', 'Artifact tabs of the current session.', {}),
  spec('artifact_close', 'Close just this artifact tab.', { target }, ['target']),
  spec('artifact_navigate', 'Scroll or navigate inside an artifact.', { target, ...move.properties }, ['target']),
  spec('artifact_query', 'Bounded DOM query inside an artifact; secret fields are excluded.', { target, selector: s, fields: { type: 'array', items: en('text', 'attrs', 'rect', 'style') }, limit: n }, ['target', 'selector']),
  spec('artifact_act', 'Perform an action inside an artifact. Do not repeat an action with an unknown result.', { target, action }, ['target', 'action']),
  spec('artifact_wait', 'Wait inside an artifact for a bounded time.', { target, selector: s, text: s, state: en('present', 'absent'), timeMs: n, timeoutMs: n }, ['target']),
  spec('artifact_screenshot', 'Screenshot of the artifact area only; unavailable without a safe provider.', { target }, ['target']),
  spec('ui_panel_tabs', 'Right panel metadata; no terminal contents or unrelated files.', {}),
  spec('ui_panel_open', 'Open an allowed right-panel tab; never runs terminal commands.', { kind: en('artifact', 'files', 'browser', 'terminal'), path: s, url: s, focus: b }, ['kind'])
];
export const MUTATING = new Set(CATALOG.filter(x => !/_(list|tabs|query|wait|screenshot)$/.test(x.name)).map(x => x.name));
export function validate(schema, value, at = 'input') {
  if (schema.oneOf) {
    const matches = schema.oneOf.filter(x => { try { validate(x, value, at); return true; } catch { return false; } });
    if (matches.length !== 1) fail('INVALID_INPUT', at + ': expected exactly one action shape');
    return;
  }
  if (schema.const !== undefined && value !== schema.const) fail('INVALID_INPUT', at + ': wrong constant');
  if (schema.enum && !schema.enum.includes(value)) fail('INVALID_INPUT', at + ': unsupported value');
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail('INVALID_INPUT', at + ': expected plain object');
    for (const key of Object.keys(value)) { if (!Object.hasOwn(schema.properties, key)) fail('INVALID_INPUT', at + ': unexpected field'); validate(schema.properties[key], value[key], at + '.' + key); }
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) fail('INVALID_INPUT', at + ': missing ' + key);
  } else if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length > LIMITS.nodes) fail('INVALID_INPUT', at + ': invalid array');
    value.forEach(x => validate(schema.items, x, at));
  } else if (schema.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1000000) fail('INVALID_INPUT', at + ': invalid finite number');
  } else if (typeof value !== schema.type || (typeof value === 'string' && value.length > LIMITS.text)) fail('INVALID_INPUT', at + ': invalid ' + schema.type);
}
// Intentionally small CSS grammar: descendant/child, tag, #id, .class,
// [data-testid="..."], [role="..."], [aria-label="..."], [name="..."].
// No universal, lists, pseudo selectors, escapes, URL-bearing attributes or shell roots.
export function checkSelector(value) {
  if (typeof value !== 'string' || !value || value.length > LIMITS.selector || value.split(/\s+|>/).filter(Boolean).length > 8 || !/^(?:[A-Za-z][\w-]*|[#.][\w-]+|\[(?:data-testid|role|aria-label|name)="[\w .:\-\u0400-\u04ff]{1,80}"\]|\s+|>)+$/.test(value)) fail('INVALID_SELECTOR', 'Selector is outside the supported grammar');
  return value;
}
export function artifactPath(value) {
  if (typeof value !== 'string' || value.length > 512 || !/^artifacts\/(?:[\w .()\-\u0400-\u04ff]+\/)*[\w .()\-\u0400-\u04ff]+\.(?:html?|xhtml)$/i.test(value) || value.split('/').some(x => x === '.' || x === '..' || /[. ]$/.test(x))) fail('PATH_OUT_OF_SCOPE', 'Use a relative HTML path beneath artifacts/');
  return value;
}
export function artifactLocation(value) {
  if (typeof value !== 'string' || value.length > 512 || !/^artifacts(?:\/[\w .()\-\u0400-\u04ff]+)*$/i.test(value) || value.split('/').some(x=>x==='.'||x==='..'||/[. ]$/.test(x))) fail('PATH_OUT_OF_SCOPE','Use a relative file/directory beneath artifacts');
  return value;
}
export function checkInput(name, args) {
  const entry = CATALOG.find(x => x.name === name); if (!entry) fail('UNKNOWN_COMMAND', 'Unknown tool');
  if (jsonBytes(args) > LIMITS.inputBytes) fail('PAYLOAD_TOO_LARGE', 'Input too large');
  validate(entry.input, args);
  if (args.path) { if (name === 'dsh_ui_panel_open' && ['files','terminal'].includes(args.kind)) artifactLocation(args.path); else artifactPath(args.path); }
  for (const selector of [args.selector, args.action?.selector]) if (selector !== undefined) checkSelector(selector);
  if (args.hash !== undefined && !/^#[\w.:-]{1,128}$/.test(args.hash)) fail('INVALID_INPUT', 'Invalid artifact hash');
  if (args.url !== undefined) { let u; try { u = new URL(args.url); } catch { fail('URL_NOT_ALLOWED','Invalid browser URL'); } if (!['https:','http:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) fail('URL_NOT_ALLOWED','Only credential-free HTTP(S) URLs without query/hash are supported'); }
  if (args.limit !== undefined && (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > LIMITS.nodes)) fail('INVALID_INPUT', 'limit must be 1..50');
  for (const key of ['timeMs', 'timeoutMs']) if (args[key] !== undefined && (!Number.isInteger(args[key]) || args[key] < 0 || args[key] > LIMITS.timeout)) fail('INVALID_INPUT', key + ' must be 0..15000');
  if (name.endsWith('_wait') && [args.selector !== undefined, args.text !== undefined, args.timeMs !== undefined].filter(Boolean).length !== 1) fail('INVALID_INPUT', 'wait requires exactly one of selector/text/timeMs');
  if (name.endsWith('_navigate') && [args.selector, args.hash, args.scroll].filter(x => x !== undefined).length !== 1) fail('INVALID_INPUT', 'navigate requires one destination');
  if (name.endsWith('_open') && [args.selector, args.hash, args.scroll].filter(x => x !== undefined).length > 1) fail('INVALID_INPUT', 'open accepts at most one navigation destination');
  if (name === 'dsh_ui_panel_open' && ((args.kind === 'browser') !== (args.url !== undefined) || (args.kind !== 'browser' && !args.path))) fail('INVALID_INPUT', 'browser needs url; other kinds need an artifact path');
  return args;
}
export function authorSchema(schema) {
  if (schema.oneOf) return { oneOf: schema.oneOf.map(authorSchema) };
  const out = { ...schema }; delete out.required;
  if (schema.properties) out.properties = Object.fromEntries(Object.entries(schema.properties).map(([k, v]) => [k, { ...authorSchema(v), ...(schema.required.includes(k) ? { required: true } : {}) }]));
  if (schema.items) out.items = authorSchema(schema.items);
  return out;
}
export function result(context = {}, effect = 'none', data = {}, error = null, commandId = null) {
  return { ok: !error, commandId, context: { sessionId: context.sessionId || null, tabId: context.tabId || null, documentId: context.documentId || null, path: context.path || null, kind: context.kind || 'artifact' }, effect, data, error };
}
export function errorResult(error, context, id) {
  const typed = typeof error?.code === 'string' && typeof error?.message === 'string';
  return result(context, ['none','applied','unknown'].includes(error?.effect) ? error.effect : 'none', {}, { code: typed ? error.code : 'INTERNAL_ERROR', message: typed ? error.message.slice(0, 256) : 'Operation failed; details withheld' }, id);
}
export function boundResult(value) {
  if (!value || typeof value.ok !== 'boolean' || !['none', 'applied', 'unknown'].includes(value.effect) || !value.context || !value.data || (value.error !== null && typeof value.error?.code !== 'string')) fail('INVALID_RECEIPT', 'Malformed result');
  if (jsonBytes(value) > (value.data.image ? LIMITS.captureBytes : LIMITS.bytes)) fail('PAYLOAD_TOO_LARGE', 'Result exceeds size limit');
  return value;
}
export const OUTPUT = object({ ok: b, commandId: { oneOf: [s, { type: 'null' }] }, context: object({ sessionId: { oneOf: [s, { type: 'null' }] }, tabId: { oneOf: [s, { type: 'null' }] }, documentId: { oneOf: [s, { type: 'null' }] }, path: { oneOf: [s, { type: 'null' }] }, kind: s }, ['sessionId','tabId','documentId','path','kind']), effect: en('none','applied','unknown'), data: { type: 'object', properties: {}, additionalProperties: true }, error: { oneOf: [{ type: 'null' }, object({ code: s, message: s }, ['code','message'])] } }, ['ok','commandId','context','effect','data','error']);
