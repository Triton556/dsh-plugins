import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { CATALOG, OUTPUT, authorSchema, checkInput, artifactPath, artifactLocation, result, errorResult, fail, deferrable, ToolError } from './contracts.js';
import { CommandBroker, createBridgeHandler } from './bridge.js';
import { artifactsScope, physicalArtifact, within } from './artifacts-root.js';

export function callerSession(exec) {
  const session = exec?.agent?.session;
  if (!session || typeof session.id !== 'string' || !session.id || typeof session.header?.cwd !== 'string' || !path.isAbsolute(session.header.cwd)) fail('CALLER_UNAVAILABLE', 'Caller session/workspace is unavailable');
  return session;
}
export const bootstrapRelativePath = sessionId => '.dsh/artifact-panes/tools-v1/' + createHash('sha256').update(sessionId).digest('hex').slice(0, 24) + '.json';
// The physical base of `artifacts/` comes from the workspace declaration when
// there is one (tools/artifacts-root.js). `physicalArtifact` keeps the logical
// address `artifacts/...` unchanged and only moves where it points.
export async function resolveArtifact(session, value) {
  artifactPath(value);
  const scope = await artifactsScope(session.header.cwd);
  const resolved = await fs.realpath(physicalArtifact(scope, value));
  if (!within(scope.base, resolved) || !(await fs.stat(resolved)).isFile()) fail('PATH_OUT_OF_SCOPE', 'Artifact target escapes its root');
  return resolved;
}
export async function resolveArtifactLocation(session,value) {
  artifactLocation(value);
  const scope=await artifactsScope(session.header.cwd), resolved=await fs.realpath(physicalArtifact(scope,value));
  if(!within(scope.base,resolved)) fail('PATH_OUT_OF_SCOPE','Panel location escapes artifacts');
  const stat=await fs.stat(resolved);if(!stat.isFile()&&!stat.isDirectory())fail('PATH_OUT_OF_SCOPE','Unsupported artifact location');
  return resolved;
}
export async function listArtifacts(session, limit = 50) {
  const scope = await artifactsScope(session.header.cwd);
  const entries = []; let visited = 0;
  // `visited` counts directories and candidate pages, not every file: a binary
  // archive tree must not consume the budget and hide the pages behind it.
  const walk = async (dir, rel, depth) => {
    for (const e of (await fs.readdir(dir, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
      if (entries.length >= limit) return;
      if (e.isSymbolicLink() || e.name.startsWith('.')) continue;
      if (e.isDirectory()) {
        if (depth >= 3 || ++visited > 500) continue;
        const next = path.join(dir, e.name);
        // A junction inside the declared root must not be stepped through.
        let real; try { real = await fs.realpath(next); } catch { continue; }
        if (!within(scope.base, real)) continue;
        await walk(next, rel + e.name + '/', depth + 1);
      } else if (e.isFile() && /\.(?:html?|xhtml)$/i.test(e.name)) {
        if (++visited > 500) return;
        try { const p = artifactPath('artifacts/' + rel + e.name); const resolved = await fs.realpath(physicalArtifact(scope, p)); if (within(scope.base, resolved) && (await fs.stat(resolved)).isFile()) entries.push({ path: p }); } catch {}
      }
    }
  };
  await walk(scope.base, '', 0); return { artifacts: entries, truncated: visited > 500 || entries.length >= limit };
}
// Private bootstrap is NOT the command/receipt journal. Only DSH's authenticated
// session workspace remote reads it. Never expose it as a webServer GET route.
export async function writeBootstrap(session, capability) {
  const root = await fs.realpath(session.header.cwd), relative = bootstrapRelativePath(session.id);
  let dir = root;
  for (const part of ['.dsh','artifact-panes','tools-v1']) {
    dir = path.join(dir, part); await fs.mkdir(dir, { recursive: true });
    if (!within(root, await fs.realpath(dir)) || (await fs.lstat(dir)).isSymbolicLink()) fail('PATH_OUT_OF_SCOPE', 'Bridge state directory redirects outside workspace');
  }
  const destination = path.join(root, relative), temp = path.join(dir, randomUUID() + '.tmp');
  try { await fs.writeFile(temp, JSON.stringify(capability), { mode: 0o600, flag: 'wx' }); await fs.rename(temp, destination); }
  catch (e) { // Remove only our own freshly-created temp, never existing user data.
    await fs.unlink(temp).catch(() => {}); throw e;
  }
  return relative;
}
export async function publishScreenshotResult(value, attachments) {
  if (!value.ok || !value.data.image) return value;
  if (!attachments || typeof attachments.saveImages !== 'function') fail('CAPTURE_UNAVAILABLE','Native attachment service is unavailable');
  const image = value.data.image, data = Buffer.from(image.base64,'base64');
  if (image.mimeType !== 'image/png' || data.toString('base64') !== image.base64 || data.length > 1050000) fail('CAPTURE_UNAVAILABLE','Screenshot encoding is invalid');
  // DSH ContentBlock images use durable attachments, not MCP raw-base64 blocks.
  const [attachment] = await attachments.saveImages([{data:new Uint8Array(data),mediaType:'image/png',name:'Артефакт.png'}]);
  if (!attachment || typeof attachment.attachmentId !== 'string') fail('CAPTURE_UNAVAILABLE','Attachment store returned no image reference');
  return {...value,data:{...value.data,image:{attachment,width:image.width,height:image.height}}};
}
// A hidden caller session has no mounted renderer, so a command that needs the
// live document cannot run and must not pretend otherwise. The bridge-level
// CLIENT_STALE reads like a broken channel; this code says what to do instead.
export function hiddenSession(value, name) {
  if (!value || value.ok || value.error?.code !== 'CLIENT_STALE') return value;
  return errorResult(new ToolError('SESSION_NOT_VISIBLE', name + ' needs the caller session displayed; nothing was changed. Show that chat in the DSH window and call again.'), value.context, null);
}
// `tabs` answers with the queue even when the renderer is gone: the open tabs of
// a hidden session are unknown to the host, but its waiting requests are not.
export async function tabsWithQueue(sessionId, broker, signal) {
  const pending = broker.rows(sessionId).map(row => ({
    tabId: row.target?.tabId ?? null, documentId: null, path: row.path, kind: 'artifact',
    ready: false, active: false, pending: true, request: row.name,
    commandId: row.commandId, position: row.position, expiresAt: row.expiresAt,
  }));
  if (!broker.live(sessionId)) return result({ sessionId }, 'none', { live: false, pending: pending.length, tabs: pending });
  const value = await broker.submit(sessionId, 'dsh_artifact_tabs', {}, { signal });
  // The renderer can leave between the check above and the delivery; the queue
  // is still the honest answer in that race.
  if (!value.ok) return value.error?.code === 'CLIENT_STALE' ? result({ sessionId }, 'none', { live: false, pending: pending.length, tabs: pending }) : value;
  const tabs = Array.isArray(value.data?.tabs) ? value.data.tabs.map(tab => ({ ...tab, pending: false })) : [];
  return { ...value, data: { ...value.data, live: true, pending: pending.length, tabs: [...tabs, ...pending] } };
}
export function registerArtifactTools(ctx, { defineTool, origin, host, bootstrapWriter = writeBootstrap, broker = new CommandBroker(), allowedBrowserOrigins = [], attachments = null }) {
  if (typeof defineTool !== 'function' || !ctx.tools?.register || !ctx.webServer?.register) throw new Error('tools, webServer and defineTool are required');
  const disposers = [], bootstrapped = new Map();
  disposers.push(ctx.webServer.register({ kind: 'exact', path: '/artifact-panes/tools-v1/channel', handler: createBridgeHandler(broker, { allowedOrigin: origin, allowedHost: host }) }));
  for (const entry of CATALOG) {
    disposers.push(ctx.tools.register(defineTool({ name: entry.name, description: entry.description, parameters: authorSchema(entry.input).properties, timeoutMs: 18000, isConcurrencySafe: () => false,
      output: { schema: authorSchema(OUTPUT), render: (_args, value) => {
        const image = value.data?.image;
        return [{ type:'text',text:JSON.stringify(value) },...(image?.attachment?[{type:'image',attachment:image.attachment}]:[])];
      } },
      execute: async (args, exec) => {
        let session, id;
        try {
          checkInput(entry.name, args); session = callerSession(exec); id = session.id;
          if (args.url && !allowedBrowserOrigins.includes(new URL(args.url).origin)) fail('URL_NOT_ALLOWED','Browser origin is not allowed by the host integration policy');
          if (entry.name === 'dsh_artifact_screenshot' && !attachments?.saveImages) fail('CAPTURE_UNAVAILABLE','Native image attachment service is not integrated');
          // A root cannot silently change underneath an existing lease.
          const root = await fs.realpath(session.header.cwd), previous = bootstrapped.get(id);
          if (previous && previous !== root) fail('STALE_WORKSPACE', 'Caller workspace changed; reload bridge registration');
          if (!previous) { await bootstrapWriter(session, broker.bind(id)); bootstrapped.set(id,root); }
          if (entry.name === 'dsh_artifact_list') return result({ sessionId: id }, 'none', await listArtifacts(session,args.limit));
          if (entry.name === 'dsh_artifact_tabs') return await tabsWithQueue(id, broker, exec.signal);
          if (args.path) { if (entry.name==='dsh_ui_panel_open'&&['files','terminal'].includes(args.kind)) await resolveArtifactLocation(session,args.path); else await resolveArtifact(session,args.path); }
          // The path was resolved above, while the caller's workspace is still
          // authoritative, so a queued request grants no new reach later.
          const defer = deferrable(entry.name, args);
          let value = await broker.submit(id, entry.name, args, { signal: exec.signal, defer });
          if (!defer) value = hiddenSession(value, entry.name);
          if (entry.name !== 'dsh_artifact_screenshot') return value;
          try { return await publishScreenshotResult(value,attachments); }
          catch { return errorResult({code:'CAPTURE_UNAVAILABLE',message:'Artifact image could not be admitted to the native attachment store'},value.context,value.commandId); }
        } catch (e) { return errorResult(e, { sessionId: id, ...args?.target, path: args?.path }); }
      }
    })));
  }
  let disposed = false;
  return { broker, dispose() { if (disposed) return; disposed = true; broker.dispose(); for (const dispose of disposers.reverse()) if (typeof dispose === 'function') dispose(); } };
}
