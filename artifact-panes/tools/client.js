import { LIMITS, VERSION, MUTATING, checkInput, artifactPath, result, errorResult, fail, ToolError, boundResult } from './contracts.js';

export class FrameRegistry {
  constructor(win) { this.win = win; this.frames = new Map(); }
  attach({ sessionId, tabId, path, iframe }) {
    artifactPath(path);
    this.detach(tabId);
    const entry = { sessionId, tabId, path, kind:'artifact', iframe, documentId:this.win.crypto.randomUUID(), pending:new Map(), ready:false };
    const { port1, port2 } = new this.win.MessageChannel(); entry.port = port1;
    const invalidate = () => { if (this.frames.get(tabId) === entry) this.detach(tabId); };
    // Call attach from the iframe's load handler, never before the packaged
    // dispatcher is installed. The NEXT load invalidates this document lease.
    iframe.addEventListener('load',invalidate,{once:true}); entry.invalidate = invalidate;
    port1.onmessage = event => {
      if (event.data?.type === 'ready' && event.data.documentId === entry.documentId) { entry.ready = true; return; }
      const pending = entry.pending.get(event.data?.id);
      if (event.data?.type !== 'result' || !pending) return;
      entry.pending.delete(event.data.id); clearTimeout(pending.timer);
      try {
        const value = boundResult(event.data.value);
        if (value.context.sessionId !== entry.sessionId || value.context.tabId !== tabId || value.context.documentId !== entry.documentId || value.commandId !== event.data.id) fail('INVALID_RECEIPT','Iframe receipt identity mismatch');
        pending.resolve({ ...value, context:{ ...value.context, path:entry.path, kind:'artifact' } });
      } catch (e) { pending.resolve(errorResult(new ToolError('INVALID_RECEIPT',e.message,pending.mutating?'unknown':'none'),entry,event.data.id)); }
    };
    port1.start?.(); this.frames.set(tabId,entry);
    iframe.contentWindow.postMessage({ type:'dsh-artifact-tools-v1-connect', documentId:entry.documentId },'*',[port2]);
    return { documentId:entry.documentId, dispose:() => { if (this.frames.get(tabId) === entry) this.detach(tabId); } };
  }
  detach(tabId) {
    const e = this.frames.get(tabId); if (!e) return;
    this.frames.delete(tabId); e.iframe.removeEventListener('load',e.invalidate);
    e.port.postMessage({type:'dispose'}); e.port.close();
    for (const [id,p] of e.pending) { clearTimeout(p.timer); p.resolve(errorResult(new ToolError('STALE_DOCUMENT','Frame navigated or closed',p.mutating?'unknown':'none'),e,id)); }
    e.pending.clear();
  }
  target(sessionId, target) {
    const e = this.frames.get(target.tabId);
    if (!e || e.sessionId !== sessionId || !e.iframe.isConnected) fail('TAB_CLOSED','Artifact tab is not mounted for caller');
    if (e.documentId !== target.documentId) fail('STALE_DOCUMENT','Artifact document was replaced');
    if (!e.ready) fail('FRAME_NOT_READY','Packaged iframe dispatcher has not acknowledged');
    return e;
  }
  async execute(cmd) {
    const e = this.target(cmd.sessionId,cmd.args.target), delay = cmd.deadline - Date.now();
    if (delay <= 0) fail('TIMEOUT','Frame command expired');
    const a = cmd.args.action;
    const needsFocus = a?.kind === 'focus' || a?.kind === 'press' && !(a.key === 'Enter' && a.submit === true);
    if (needsFocus && (!this.win.document.hasFocus() || this.win.document.activeElement !== e.iframe)) fail('FOCUS_NOT_OWNED','Artifact must already own focus for focus/press');
    return new Promise(resolve => {
      const mutating = MUTATING.has(cmd.name);
      const timer = setTimeout(() => { e.pending.delete(cmd.id); resolve(errorResult(new ToolError(mutating?'UNKNOWN_EFFECT':'TIMEOUT','Iframe receipt deadline exceeded',mutating?'unknown':'none'),e,cmd.id)); },delay);
      e.pending.set(cmd.id,{ resolve,timer,mutating });
      e.port.postMessage({ type:'focus-state', owned:this.win.document.hasFocus() && this.win.document.activeElement === e.iframe });
      e.port.postMessage({ type:'execute', command:{...cmd,path:e.path} });
    });
  }
  dispose() { for (const id of [...this.frames.keys()]) this.detach(id); }
}

// Native adapter uses only the observed sidebar controller. Optional kinds are
// explicit integration providers, never guessed kind IDs or shell DOM selectors.
export function createPanelAdapter({ sidebar, frames, mountedSession, readTabs, providers = {}, focusSafe = () => false }) {
  const assertSession = id => { if (mountedSession() !== id) fail('SESSION_NOT_VISIBLE','Caller session is not mounted; no chat switch was made'); };
  const artifactTabs = async sessionId => {
    const rows=await readTabs(sessionId),known=[...frames.frames.values()].filter(e=>e.sessionId===sessionId),ids=new Set([...rows.filter(t=>t.safeKind==='artifact').map(t=>t.id),...known.map(e=>e.tabId)]);
    return [...ids].slice(0,50).map(tabId=>{const e=known.find(e=>e.tabId===tabId),r=rows.find(r=>r.id===tabId);return {tabId,documentId:e?.documentId||null,path:e?.path||r?.path||null,kind:'artifact',ready:!!e?.ready,active:r?.active===true};});
  };
  const context = (sessionId,row) => ({sessionId,...row});
  const checkFocus = focus => { if (focus && !focusSafe()) fail('FOCUS_NOT_OWNED','Explicit focus would interrupt user activity'); };
  return {
    async execute(cmd, signal) {
      let issued = false;
      try {
      const guard = () => { if (signal?.aborted) fail('ABORTED','Panel runtime stopped'); if (Date.now() >= cmd.deadline) fail('TIMEOUT','Panel command expired'); assertSession(cmd.sessionId); };
      guard();
      assertSession(cmd.sessionId); checkInput(cmd.name,cmd.args);
      const a = cmd.args, sessionId = cmd.sessionId;
      if (cmd.name === 'dsh_artifact_tabs') return result({sessionId},'none',{tabs:await artifactTabs(sessionId)},null,cmd.id);
      if (cmd.name === 'dsh_ui_panel_tabs') {
        // Content, outside paths, arbitrary page titles and terminal buffers are
        // not exposed. Kind/id/active are sufficient for choosing a panel.
        const tabs = (await readTabs(sessionId)).slice(0,50).map(t => ({tabId:t.id,kind:['artifact','files','browser','terminal'].includes(t.safeKind)?t.safeKind:'other',active:t.active === true}));
        return result({sessionId,kind:'panel'},'none',{tabs},null,cmd.id);
      }
      if (cmd.name === 'dsh_artifact_close') {
        const e = frames.target(sessionId,a.target);
        issued = true; sidebar.close(e.tabId);
        const stillOpen = (await readTabs(sessionId)).some(t => t.id === e.tabId);
        if (stillOpen) { issued = false; fail('CLOSE_REFUSED','Native panel retained the tab'); }
        frames.detach(e.tabId); return result(e,'applied',{closed:true},null,cmd.id);
      }
      if (cmd.name === 'dsh_artifact_open' || cmd.name === 'dsh_ui_panel_open' && a.kind === 'artifact') {
        artifactPath(a.path); checkFocus(a.focus);
        if (a.reload && !providers.reload) fail('UNSUPPORTED_ACTION','Native reload hook is not integrated');
        const before = (await readTabs(sessionId)).filter(t => t.safeKind === 'artifact');
        const previousIds = new Set(before.map(t=>t.id));
        const address = 'dsh-resource://file/session/' + encodeURIComponent(sessionId) + '/' + a.path.split('/').map(encodeURIComponent).join('/');
        const current = sidebar.active();
        if (a.placement === 'current' && current && !before.some(t => t.id === current.id)) fail('TARGET_OUT_OF_SCOPE','Current tab is not an artifact');
        issued = true;
        sidebar.openResource(address, { ...(a.placement === 'current' && current ? {replaceTab:current.id}:{}), ...(a.placement === 'new'?{revealIfOpened:false}:{} ) });
        const after = (await readTabs(sessionId)).filter(t=>t.safeKind==='artifact'&&t.path===a.path);
        const expected = a.placement==='new' ? after.find(t=>!previousIds.has(t.id)) : after.find(t=>t.id===sidebar.active()?.id)||after.find(t=>t.id===current?.id)||after.find(t=>!previousIds.has(t.id))||(after.length===1?after[0]:null);
        if (!expected) throw new ToolError('UNKNOWN_EFFECT','Open issued but exact destination tab was not observed','unknown');
        // Await the actual mount/ready and identify by exact caller path, never a
        // latest-chat fallback. A failed receipt after open has unknown effect.
        let entry;
        while (Date.now() < cmd.deadline) {
          guard();
          entry = [...frames.frames.values()].find(e => e.sessionId === sessionId && e.tabId===expected.id && e.path === a.path && e.ready);
          if (entry) break;
          await new Promise(r => setTimeout(r,50));
        }
        if (!entry) throw new ToolError('UNKNOWN_EFFECT','Open issued but target did not become ready','unknown');
        if (a.reload) {
          const old = entry.documentId;
          await providers.reload(entry,{signal,deadline:cmd.deadline});
          entry = null;
          while (Date.now() < cmd.deadline) { guard(); entry = [...frames.frames.values()].find(e => e.sessionId === sessionId && e.tabId===expected.id && e.path === a.path && e.ready && e.documentId !== old); if (entry) break; await new Promise(r=>setTimeout(r,50)); }
          if (!entry) throw new ToolError('UNKNOWN_EFFECT','Reload issued but new document not ready','unknown');
        }
        guard(); if (a.focus) sidebar.focus(entry.tabId);
        if (a.selector || a.hash || a.scroll) {
          const value = await frames.execute({...cmd,name:'dsh_artifact_navigate',args:{target:{tabId:entry.tabId,documentId:entry.documentId},...(a.selector?{selector:a.selector}:{}),...(a.hash?{hash:a.hash}:{}),...(a.scroll?{scroll:a.scroll}:{})}});
          if (!value.ok) return {...value,effect:'applied'};
        }
        return result(context(sessionId,entry),'applied',{opened:true,reloaded:!!a.reload},null,cmd.id);
      }
      if (cmd.name === 'dsh_ui_panel_open') {
        checkFocus(a.focus);
        if (!providers[a.kind]) fail('UNSUPPORTED_PANEL','Panel provider is not configured: '+a.kind);
        // Provider receives validated artifact path or policy-checked URL. It may
        // open a tab only; terminal commands/content and external file reads are absent.
        let data;
        try { data = await providers[a.kind]({sessionId,path:a.path,url:a.url,focus:!!a.focus,deadline:cmd.deadline,signal}); }
        catch(e) { if (!e?.code) throw new ToolError('UNKNOWN_EFFECT','Panel provider failed after invocation','unknown'); throw e; }
        return result({sessionId,kind:a.kind,tabId:data.tabId,path:a.path},data.effect || 'applied',{opened:true},null,cmd.id);
      }
      return await frames.execute(cmd);
      } catch (e) { if (issued && (!e?.effect || e.effect === 'none')) throw new ToolError(e?.code||'UNKNOWN_EFFECT',e?.code&&e?.message?e.message:'Panel operation failed after issue','unknown'); throw e; }
    }
  };
}

export function createChannel(fetch, endpoint, capability, instance) {
  return async (op, payload = {}, signal) => {
    const response = await fetch(endpoint,{method:'POST',mode:'same-origin',credentials:'same-origin',cache:'no-store',signal,headers:{'Content-Type':'application/json',Authorization:'Bearer '+capability.token},body:JSON.stringify({op,sessionId:capability.sessionId,clientId:capability.clientId,instance,...payload})});
    const text = await response.text(); if (text.length > LIMITS.bytes) fail('PAYLOAD_TOO_LARGE','Bridge response too large');
    const value = JSON.parse(text); if (!response.ok || !value.ok) fail(value.error?.code || 'BRIDGE_UNAVAILABLE',value.error?.message || 'Bridge rejected request');
    return value.data;
  };
}
export function startClient({ sessionId, readBootstrap, adapter, fetch, endpoint = '/artifact-panes/tools-v1/channel', crypto, onStatus = () => {} }) {
  const abort = new AbortController(), instance = crypto.randomUUID(); let channel, busy = false, stopped = false;
  const tick = async () => {
    if (stopped || busy) return; busy = true;
    try {
      if (!channel) {
        const c = await readBootstrap(sessionId,abort.signal);
        if (c.version !== VERSION || c.sessionId !== sessionId || typeof c.token !== 'string' || typeof c.clientId !== 'string') fail('UNAUTHORIZED','Bootstrap identity mismatch');
        channel = createChannel(fetch,endpoint,c,instance);
      }
      const cmd = await channel('poll',{},abort.signal);
      if (!cmd) { onStatus({state:'ready',sessionId}); return; }
      if (cmd.sessionId !== sessionId || cmd.version !== VERSION || cmd.deadline <= Date.now()) fail('STALE_COMMAND','Command identity/deadline mismatch');
      // Host must ACK start BEFORE any mutation. Lost ACK means no execution.
      await channel('receipt',{id:cmd.id,phase:'start'},abort.signal);
      if (Date.now() >= cmd.deadline || stopped) fail('TIMEOUT','Command expired before local execution');
      let value;
      const operation = new AbortController(),cancel = () => operation.abort();
      abort.signal.addEventListener('abort',cancel,{once:true});
      const deadlineTimer = setTimeout(cancel,Math.max(1,cmd.deadline-Date.now()));
      try { value = await adapter.execute(cmd,operation.signal); }
      catch(e) { value = errorResult(e,{sessionId,...cmd.args.target,path:cmd.args.path},cmd.id); }
      finally {clearTimeout(deadlineTimer);abort.signal.removeEventListener('abort',cancel);}
      if (stopped) return;
      await channel('receipt',{id:cmd.id,phase:'done',value},abort.signal);
      onStatus({state:'receipt',sessionId,commandId:cmd.id,effect:value.effect});
    } catch(e) {
      onStatus({state:'error',sessionId,code:e.code || 'BRIDGE_UNAVAILABLE'});
      // Never replay an execution, even when sending its done receipt failed.
      if (['UNAUTHORIZED','STALE_COMMAND'].includes(e.code)) channel = null;
    } finally { busy = false; }
  };
  const pollTimer = setInterval(tick,300);
  const heartbeat = setInterval(() => { if (channel && !stopped) channel('heartbeat',{},abort.signal).catch(e=>onStatus({state:'error',code:e.code || 'BRIDGE_UNAVAILABLE',sessionId})); },1500);
  tick();
  return { stop() { stopped = true; clearInterval(pollTimer); clearInterval(heartbeat); abort.abort(); }, tick };
}

export async function readWorkspaceBootstrap(ctx, sessionId, signal) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256',new TextEncoder().encode(sessionId));
  const key = [...new Uint8Array(digest)].map(x=>x.toString(16).padStart(2,'0')).join('').slice(0,24);
  const value = await ctx.remote.workspaceFiles.readBytes(sessionId,'.dsh/artifact-panes/tools-v1/'+key+'.json',{},signal);
  if (!value || value.ok === false || !value.value?.data || value.value.data.length > 4096) fail('BRIDGE_UNAVAILABLE','Private bootstrap is not available yet; run artifact_list first');
  return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(value.value.data));
}

export function nativeTabMetadata(sidebar, sessionId) {
  if (typeof sidebar.tabsIn !== 'function') fail('UNSUPPORTED_PANEL','Native tabsIn source contract changed');
  const active = sidebar.active()?.id;
  return sidebar.tabsIn(sessionId).map(t => {
    let artifact;
    try {
      const prefix = 'dsh-resource://file/session/' + encodeURIComponent(sessionId) + '/';
      if (t.kind === 'artifact' && t.contentId.startsWith(prefix)) artifact = artifactPath(t.contentId.slice(prefix.length).split('/').map(decodeURIComponent).join('/'));
    } catch {}
    return {id:t.id, safeKind:artifact?'artifact':['files','browser','terminal'].includes(t.kind)?t.kind:'other',active:t.id===active,...(artifact?{path:artifact}:{})};
  });
}

export function createNativeBrowserProvider(sidebar, { allowedOrigins = [] } = {}) {
  return async ({sessionId,url,focus}) => {
    const u = new URL(url);
    if (!allowedOrigins.includes(u.origin) || !['http:','https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) fail('URL_NOT_ALLOWED','Browser URL is not permitted by integration policy');
    const before = new Set(nativeTabMetadata(sidebar,sessionId).map(t=>t.id));
    sidebar.openTab('browser',{params:{url:u.href},revealIfOpened:false});
    const opened = nativeTabMetadata(sidebar,sessionId).find(t=>t.safeKind==='browser'&&!before.has(t.id));
    if (!opened) throw new ToolError('UNKNOWN_EFFECT','Browser open issued but new tab identity was not observed','unknown');
    if (focus) sidebar.focus(opened.id);
    return {tabId:opened.id,effect:'applied'};
  };
}

export function createClientRuntime({ win = window, ctx, sessionId, providers = {}, captureProvider = null, captureFactory, allowedBrowserOrigins = [], onStatus }) {
  const frames = new FrameRegistry(win), sidebar = ctx.sidebarRight;
  if (typeof captureFactory !== 'function') throw new Error('Supply packaged createCaptureAdapter');
  const panel = createPanelAdapter({sidebar,frames,mountedSession:()=>sidebar.mounted.getSnapshot(),readTabs:id=>nativeTabMetadata(sidebar,id),providers:{browser:createNativeBrowserProvider(sidebar,{allowedOrigins:allowedBrowserOrigins}),...providers},focusSafe:()=>win.document.hasFocus()&&[...frames.frames.values()].some(e=>win.document.activeElement===e.iframe)});
  const capture = captureFactory({frames,provider:captureProvider});
  const adapter = {execute:(cmd,signal)=>{if(sidebar.mounted.getSnapshot()!==cmd.sessionId)fail('SESSION_NOT_VISIBLE','Caller session is not mounted');return cmd.name==='dsh_artifact_screenshot'?capture(cmd):panel.execute(cmd,signal);}};
  const client = startClient({sessionId,readBootstrap:(id,signal)=>readWorkspaceBootstrap(ctx,id,signal),adapter,fetch:win.fetch.bind(win),crypto:win.crypto,onStatus});
  return {frames,stop(){client.stop();frames.dispose();}};
}
