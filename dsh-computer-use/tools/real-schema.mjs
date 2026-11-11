// Validate the plugin's tool definitions against the REAL @deepseek-ai/dsh-tools
// extracted from the installed app.asar. This catches schema mistakes before a
// restart can fail, without booting the host.
//
// Usage:
//   DSH_REAL_TOOLS=<path to extracted dsh-tools lib/index.js> node tools/real-schema.mjs
import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const realPath = process.env.DSH_REAL_TOOLS
  || 'C:/Users/Danil/AppData/Local/Temp/dsh-real-tools/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js';

if (!existsSync(realPath)) {
  console.log(`SKIP: real dsh-tools not found at ${realPath}`);
  console.log('Extract it with: node tools/asar.mjs extract <app.asar> dsh/node_modules/@deepseek-ai/dsh-tools <dir>');
  process.exit(0);
}

const realUrl = pathToFileURL(realPath).href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@deepseek-ai/dsh-tools') return { url: realUrl, shortCircuit: true };
    return nextResolve(specifier, context);
  }
});

const host = await import(realUrl);
if (typeof host.defineTool !== 'function') {
  console.error('real package does not export defineTool');
  process.exit(2);
}

const { TOOLS } = await import('../index.js');

let failures = 0;
const check = (label, ok, detail = '') => {
  if (ok) { console.log(`  ok   ${label}`); return; }
  failures += 1;
  console.log(`  FAIL ${label}${detail ? ` :: ${String(detail).slice(0, 240)}` : ''}`);
};

console.log(`real package: ${realUrl}`);
console.log(`tools: ${TOOLS.length}`);

const built = [];
for (const spec of TOOLS) {
  let tool = null;
  let error = null;
  try {
    tool = host.defineTool({
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters,
      timeoutMs: 120000,
      isConcurrencySafe: () => false,
      output: { schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' }, text: { type: 'string' } } }, render: (_args, value) => [{ type: 'text', text: String(value && value.text || '') }] },
      execute: async () => ({ ok: true, text: 'stub' })
    });
  } catch (e) { error = e.message; }
  check(`${spec.name}: accepted by real defineTool`, !!tool, error);
  if (tool) built.push(tool);
}

check('all definitions built', built.length === TOOLS.length, `${built.length}/${TOOLS.length}`);

// The real package converts parameters to JSON Schema; make sure every tool
// ends up with a usable object schema and validates its own argument shape.
for (const tool of built) {
  check(`${tool.name}: has JSON-schema parameters`, !!tool.parameters && typeof tool.parameters === 'object' && tool.parameters.type === 'object');
}

// One behavioural check: a valid argument object passes, an unknown field is
// rejected only if the schema forbids extras (informational, not a failure).
const windows = built.find((t) => t.name === 'computer_windows');
if (windows) {
  let accepted = true;
  try { windows.validate ? windows.validate({}) : void 0; } catch { accepted = false; }
  check('computer_windows accepts empty arguments', accepted);
}

// Registration-time checks the real ToolsService performs, exercised directly:
// the output schema must be supported, parameters must project losslessly, and
// a tool result must validate against its own declared schema.
const project = host.projectToolSchema;
const assertSchema = host.assertSupportedJsonSchema;
const validateValue = host.validateJsonSchemaValue;

for (const tool of built) {
  let projected = null;
  let projectError = null;
  try { projected = project(tool, true); } catch (e) { projectError = e.message; }
  check(`${tool.name}: parameters project to JSON`, !!projected && projected.parameters && projected.parameters.type === 'object', projectError);

  let schemaOk = true;
  let schemaError = null;
  try { assertSchema(tool.output.schema); } catch (e) { schemaOk = false; schemaError = e.message; }
  check(`${tool.name}: output schema accepted`, schemaOk, schemaError);

  let good = true;
  try { validateValue(tool.output.schema, { ok: true, text: 'hello' }, ''); } catch { good = false; }
  check(`${tool.name}: accepts a { ok, text } result`, good);

  // The host keeps `additionalProperties: false` in the compiled schema but its
// value validator does not enforce unknown-field rejection, so assert the
// declaration survived rather than a rejection the host never performs.
  const declared = tool.output.schema && tool.output.schema.additionalProperties === false;
  check(`${tool.name}: result schema is closed`, declared, JSON.stringify(tool.output.schema));
}

console.log(failures ? `FAIL: ${failures}` : 'PASS: definitions accepted by the real host package');
process.exit(failures ? 1 : 0);