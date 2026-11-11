// Proposed destination: artifact-panes/tools/host-load.mjs. No side effects on import.
// All non-builtin imports happen after the parent module/apply diagnostics.
export function trustedCarrier(webServer) {
  if (!webServer || typeof webServer.register !== 'function' || typeof webServer.getOrigin !== 'function') throw Object.assign(new Error('webServer.getOrigin/register are required'),{code:'CARRIER_UNAVAILABLE'});
  const origin = webServer.getOrigin();
  const parsed = new URL(origin);
  if (!['http:','https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.origin !== origin || parsed.search || parsed.hash || parsed.pathname !== '/') throw Object.assign(new Error('webServer returned an invalid trusted origin'),{code:'CARRIER_UNAVAILABLE'});
  return {origin,host:parsed.host};
}

export async function activateHostTools(ctx, {
  webServer,
  log = () => {},
  importTools = () => import('@deepseek-ai/dsh-tools'),
  importRegistrar = () => import('./host.js'),
} = {}) {
  let tools;
  try { tools = ctx.get('tools'); } catch {}
  if (!tools || typeof tools.register !== 'function') {
    log('tools-unavailable');
    return () => {};
  }
  const {origin,host} = trustedCarrier(webServer);
  log('tools-import-start');
  let defineTool,registerArtifactTools;
  try {
    ({defineTool} = await importTools());
    ({registerArtifactTools} = await importRegistrar());
    if (typeof defineTool !== 'function' || typeof registerArtifactTools !== 'function') throw Object.assign(new Error('Tool module export is unavailable'),{code:'INVALID_TOOL_EXPORT'});
  } catch(error) {
    log('tools-import-failed',{code:typeof error?.code==='string'?error.code:'IMPORT_FAILED',message:String(error?.message||'Import failed').slice(0,400)});
    throw error;
  }
  // The service ID is plural. It is optional and never an activation dependency.
  let attachments = null;
  try { attachments = ctx.get('attachments') || null; } catch {}
  if (typeof attachments?.saveImages !== 'function') attachments = null;
  const cleanup = [];
  const own = dispose => {
    let active = true;
    const once = () => { if (!active) return;active=false;return dispose?.(); };
    cleanup.push(once);return once;
  };
  const disposeAll = () => { for (const dispose of cleanup.reverse()) { try {dispose();} catch(error) {log('cleanup-failed',{code:typeof error?.code==='string'?error.code:'CLEANUP_FAILED'});} } cleanup.length=0; };
  // Preserve the traced/native service calls while making partial registration
  // failure clean up the route and every successfully registered tool.
  const facade = {
    tools:{register:definition=>own(tools.register(definition))},
    webServer:{register:route=>own(webServer.register(route))},
  };
  const register = () => registerArtifactTools(facade,{defineTool,origin,host,attachments,allowedBrowserOrigins:[]});
  let installed;
  try {
    try {
      installed = register();
    } catch (error) {
      // A pre-fix build registered this exact bridge route and then failed before
      // retaining its disposer, leaving an orphan. Remove only that path and retry
      // once so this registration owns and can dispose it; a clean start finds none.
      const orphan = '/artifact-panes/tools-v1/channel';
      if (!(webServer.exact instanceof Map) || !String(error?.message || '').includes(`duplicate exact route "${orphan}"`)) throw error;
      webServer.exact.delete(orphan);
      log('stale-route-removed',{path:orphan});
      installed = register();
    }
    if (!installed || typeof installed.dispose !== 'function') throw Object.assign(new Error('Registration returned no disposer'),{code:'INVALID_REGISTRATION'});
    log('tools-registered',{origin,host,attachments:!!attachments});
  } catch(error) {
    disposeAll();
    log('tools-registration-failed',{code:typeof error?.code==='string'?error.code:'REGISTRATION_FAILED',message:String(error?.message||'Registration failed').slice(0,400)});
    throw error;
  }
  let disposed = false;
  return () => {
    if (disposed) return;disposed=true;
    try {installed.dispose();} finally {disposeAll();log('tools-disposed');}
  };
}
