import { createClientRuntime } from './client.js';
import { createCaptureAdapter } from './capture.js';
import { artifactPath, fail } from './contracts.js';

// One poller for the mounted caller session. Retained frames reconnect when a
// session returns, without loading any chat or activating an OS window.
export function createRuntimeCoordinator({ win = window, ctx, providers = {}, captureProvider = null, allowedBrowserOrigins = [], onStatus }) {
  const descriptors = new Map(); let current, runtime;
  const attach = descriptor => runtime?.frames.attach(descriptor);
  const sync = () => {
    const id = ctx.sidebarRight.mounted.getSnapshot();
    if (id === current) return;
    runtime?.stop(); runtime = null; current = id;
    if (typeof id !== 'string' || !id) return;
    runtime = createClientRuntime({win,ctx,sessionId:id,captureFactory:createCaptureAdapter,captureProvider,allowedBrowserOrigins,onStatus,providers:{...providers,reload:async (entry,operation)=>{
      const descriptor = descriptors.get(entry.tabId);
      if (!descriptor || descriptor.sessionId !== id || typeof descriptor.reload !== 'function') fail('UNSUPPORTED_ACTION','Fresh-file reload callback is not integrated');
      await descriptor.reload(operation);
    }}});
    for (const descriptor of descriptors.values()) if (descriptor.sessionId === id && descriptor.iframe.isConnected) attach(descriptor);
  };
  const unsubscribe = ctx.sidebarRight.mounted.subscribe(sync); sync();
  return {
    // Invoke after the frame load event; the dispatcher must be installed first.
    registerFrame(descriptor) {
      try { artifactPath(descriptor.path); }
      catch(e) { onStatus?.({state:'excluded',sessionId:descriptor.sessionId,code:e.code});return()=>{}; }
      if (typeof descriptor.sessionId !== 'string' || typeof descriptor.tabId !== 'string' || !descriptor.iframe?.contentWindow) fail('INVALID_INPUT','Invalid artifact frame descriptor');
      descriptors.set(descriptor.tabId,descriptor);
      if (descriptor.sessionId === current) attach(descriptor);
      return () => {
        if (descriptors.get(descriptor.tabId) !== descriptor) return;
        descriptors.delete(descriptor.tabId); runtime?.frames.detach(descriptor.tabId);
      };
    },
    stop() { unsubscribe();runtime?.stop();runtime=null;descriptors.clear();current=null; }
  };
}

export function withPackagedDispatcher(html, packagedSource) {
  if (typeof html !== 'string' || typeof packagedSource !== 'string') throw new Error('Static packaged HTML/source required');
  const script = '<script>' + packagedSource.replace(/<\/script/gi,'<\\/script') + '<'+'/script>';
  const at = html.search(/<\/body\s*>/i);
  return at < 0 ? html + script : html.slice(0,at) + script + html.slice(at);
}
