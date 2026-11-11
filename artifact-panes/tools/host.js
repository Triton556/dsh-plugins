import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { CATALOG, OUTPUT, authorSchema, checkInput, artifactPath, artifactLocation, result, errorResult, fail } from './contracts.js';
import { CommandBroker, createBridgeHandler } from './bridge.js';

export function callerSession(exec) {
  const session = exec?.agent?.session;
  if (!session || typeof session.id !== 'string' || !session.id || typeof session.header?.cwd !== 'string' || !path.isAbsolute(session.header.cwd)) fail('CALLER_UNAVAILABLE', 'Caller session/workspace is unavailable');
  return session;
}
export const bootstrapRelativePath = sessionId => '.dsh/artifact-panes/tools-v1/' + createHash('sha256').update(sessionId).digest('hex').slice(0, 24) + '.json';
const within = (base, candidate) => { const relative = path.relative(base, candidate); return relative === '' || !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative); };
export async function resolveArtifact(session, value) {
  artifactPath(value);
  const root = await fs.realpath(session.header.cwd), artifacts = await fs.realpath(path.join(root, 'artifacts'));
  if (!within(root, artifacts)) fail('PATH_OUT_OF_SCOPE', 'Artifacts root escapes workspace');
  const resolved = await fs.realpath(path.join(root, value));
  if (!within(artifacts, resolved) || !(await fs.stat(resolved)).isFile()) fail('PATH_OUT_OF_SCOPE', 'Artifact target escapes its root');
  return resolved;
}
export async function resolveArtifactLocation(session,value) {
  artifactLocation(value);
  const root=await fs.realpath(session.header.cwd), base=await fs.realpath(path.join(root,'artifacts')), resolved=await fs.realpath(path.join(root,value));
  if (!within(root,base)||!within(base,resolved)) fail('PATH_OUT_OF_SCOPE','Panel location escapes artifacts');
  const stat=await fs.stat(resolved);if(!stat.isFile()&&!stat.isDirectory())fail('PATH_OUT_OF_SCOPE','Unsupported artifact location');
  return resolved;
}
export async function listArtifacts(session, limit = 50) {
  const root = await fs.realpath(session.header.cwd), base = await fs.realpath(path.join(root, 'artifacts'));
  if (!within(root, base)) fail('PATH_OUT_OF_SCOPE', 'Artifacts root escapes workspace');
  const entries = []; let visited = 0;
  const walk = async (dir, rel, depth) => {
    for (const e of (await fs.readdir(dir, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
      if (++visited > 500 || entries.length >= limit) return;
      if (e.isSymbolicLink() || e.name.startsWith('.')) continue;
      if (e.isDirectory() && depth < 3) await walk(path.join(dir, e.name), rel + e.name + '/', depth + 1);
      else if (e.isFile() && /\.(?:html?|xhtml)$/i.test(e.name)) { try { const p = artifactPath('artifacts/' + rel + e.name); await resolveArtifact(session,p); entries.push({ path: p }); } catch {} }
    }
  };
  await walk(base, '', 0); return { artifacts: entries, truncated: visited > 500 || entries.length >= limit };
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
// The artifact tools only exist while the renderer has a mounted artifact tab
// (the coordinator starts with it). Opening the first tab through the broker is
// a chicken-and-egg: no tab -> no heartbeat -> CLIENT_STALE. The client already
// watches this file to open a resource, so an open call may use it as a
// bootstrap, then wait for the registered tab over the now-live bridge.
export async function openWithoutClient(session, pathValue, id, broker, timeoutMs = 8000) {
  const root = await fs.realpath(session.header.cwd);
  const file = path.join(root, '.dsh','artifact-panes','open-request.json');
  // The client keeps its own last-seen n in localStorage and ignores anything
  // not greater. Use a fixed high offset above any epoch-based value so a
  // fallback still advances after older test/manual requests; the file's n
  // keeps repeated calls monotonic within the same millisecond.
  let n = Date.now() + 1_000_000_000_000;
  try {
    const previous = JSON.parse(await fs.readFile(file, 'utf8'));
    if (Number.isFinite(previous?.n)) n = Math.max(n, Number(previous.n) + 1);
  } catch (e) { /* first request or unreadable stale file */ }
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ path: pathValue, note: 'artifact tool fallback', n }, null, 2) + '\n', 'utf8');
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const tabs = await broker.submit(id, 'dsh_artifact_tabs', {}, { timeoutMs: 1500 });
    if (tabs.ok) {
      const hit = (tabs.data?.tabs || []).find(t => t.path === pathValue && typeof t.documentId === 'string' && t.documentId);
      if (hit) return result({ sessionId: id, tabId: hit.tabId, documentId: hit.documentId, path: pathValue, kind: 'artifact' }, 'applied', { opened: true, via: 'open-request' }, null, null);
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  return undefined;
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
          if (args.path) { if (entry.name==='dsh_ui_panel_open'&&['files','terminal'].includes(args.kind)) await resolveArtifactLocation(session,args.path); else await resolveArtifact(session,args.path); }
          let value = await broker.submit(id, entry.name, args, { signal: exec.signal });
          // No mounted artifact tab means no renderer heartbeat. The open tools
          // can mount the first tab through the client's existing file bridge,
          // then resume once the tab has registered its frame.
          if (!value.ok && value.error?.code === 'CLIENT_STALE' && args.path && (entry.name === 'dsh_artifact_open' || entry.name === 'dsh_ui_panel_open' && args.kind === 'artifact')) {
            try {
              const opened = await openWithoutClient(session, args.path, id, broker);
              if (opened) value = opened;
            } catch (e) { /* fall through to the original CLIENT_STALE */ }
          }
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
