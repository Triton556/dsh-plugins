import { LIMITS, checkInput, result, errorResult, fail, jsonBytes } from './contracts.js';

// Packaged code only. No eval, model scripts, parent DOM, OS input or host token.
export function createIframeExecutor(win, { documentId, now = Date.now, focusAllowed = () => false } = {}) {
  const doc = win.document;
  const protectedElement = el => el?.closest?.('[data-dsh-private], [data-secret], input[type="password"], input[type="file"], input[type="hidden"], [autocomplete="current-password"], [autocomplete="new-password"], [autocomplete="one-time-code"]');
  const requireElement = selector => {
    let el; try { el = doc.querySelector(selector); } catch { fail('INVALID_SELECTOR', 'Selector is invalid'); }
    if (!el) fail('ELEMENT_NOT_FOUND', 'Artifact element not found');
    if (protectedElement(el)) fail('PROTECTED_ELEMENT', 'Private/credential fields are excluded');
    return el;
  };
  const text = el => {
    // textContent alone leaks script bodies and private descendant values.
    let out = '', visited = 0;
    const walk = node => {
      if (++visited > 2000 || out.length >= LIMITS.text) return;
      if (node.nodeType === 3) { out += node.textContent || ''; return; }
      if (node.nodeType !== 1 || protectedElement(node) || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|INPUT|TEXTAREA|IFRAME)$/.test(node.tagName)) return;
      for (const child of node.childNodes || []) walk(child);
    };
    walk(el); return out.slice(0, LIMITS.text);
  };
  const rect = el => { const r = el.getBoundingClientRect(); return Object.fromEntries(['x','y','width','height'].map(k => [k, Math.round(r[k] * 100) / 100])); };
  const scrollWithinArtifact = el => {
    const delta = (start,size,bound,span) => start < bound ? start-bound : start+size > bound+span ? start+size-bound-span : 0;
    let parent=el.parentElement,depth=0;
    while(parent&&parent!==doc.body&&parent!==doc.documentElement&&depth++<64) {
      const style=win.getComputedStyle(parent),r=el.getBoundingClientRect(),p=parent.getBoundingClientRect();
      const left=/auto|scroll/.test(style.getPropertyValue('overflow-x'))?delta(r.x,r.width,p.x+(parent.clientLeft||0),parent.clientWidth):0;
      const top=/auto|scroll/.test(style.getPropertyValue('overflow-y'))?delta(r.y,r.height,p.y+(parent.clientTop||0),parent.clientHeight):0;
      if(left||top)parent.scrollBy({left,top,behavior:'instant'});
      parent=parent.parentElement;
    }
    const r=el.getBoundingClientRect();
    win.scrollBy({left:delta(r.x,r.width,0,win.innerWidth),top:delta(r.y,r.height,0,win.innerHeight),behavior:'instant'});
  };
  const guard = (cmd, signal) => { if (signal?.aborted || now() >= cmd.deadline) fail('TIMEOUT', 'Artifact command expired'); if (cmd.args.target?.documentId !== documentId) fail('STALE_DOCUMENT', 'Artifact document changed'); };
  const focus = el => { if (!focusAllowed()) fail('FOCUS_NOT_OWNED', 'Artifact does not own focus; user focus is preserved'); el.focus({ preventScroll: true }); };
  const submitElement = el => {
    const candidate = /^(BUTTON|INPUT)$/.test(el.tagName) ? el : el.closest?.('button,input');
    return candidate && (candidate.type || (candidate.tagName === 'BUTTON' ? 'submit' : '')) === 'submit' && candidate.form ? candidate : null;
  };
  const externalLink = el => {
    const a = el.closest?.('a[href]');
    if (!a) return false;
    const href = a.getAttribute('href') || '';
    return !/^#[\w.:-]+$/.test(href) || a.hasAttribute('download') || a.getAttribute('target') && a.getAttribute('target') !== '_self';
  };
  const doAct = a => {
    const el = requireElement(a.selector);
    if (el.disabled || el.getAttribute?.('aria-disabled') === 'true') fail('ELEMENT_DISABLED', 'Element is disabled');
    if (a.kind === 'focus') { focus(el); return { changed: 'focus' }; }
    if (a.kind === 'scroll') { el.scrollBy({ left: a.x, top: a.y, behavior: 'instant' }); return { changed: 'scroll', x: el.scrollLeft, y: el.scrollTop }; }
    if (a.kind === 'type') {
      if (!['INPUT','TEXTAREA'].includes(el.tagName) || el.readOnly || !/^(text|search|email|url|tel|number|textarea)$/.test(el.type || 'textarea')) fail('UNSUPPORTED_ACTION', 'type requires an editable, non-secret input or textarea');
      const next = (a.mode === 'append' ? el.value : '') + a.text;
      if (next.length > LIMITS.text) fail('PAYLOAD_TOO_LARGE', 'Resulting field value exceeds limit');
      const proto = el.tagName === 'TEXTAREA' ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto,'value').set.call(el,next);
      el.dispatchEvent(new win.Event('input', { bubbles: true }));
      el.dispatchEvent(new win.Event('change', { bubbles: true }));
      return { changed: 'value', length: next.length };
    }
    if (a.kind === 'select') {
      if (el.tagName !== 'SELECT' || (!el.multiple && a.values.length !== 1) || a.values.some(v => !Array.from(el.options).some(o => o.value === v && !o.disabled))) fail('UNSUPPORTED_ACTION', 'Invalid select values');
      for (const o of el.options) o.selected = a.values.includes(o.value);
      el.dispatchEvent(new win.Event('input', { bubbles: true })); el.dispatchEvent(new win.Event('change', { bubbles: true }));
      return { changed: 'selection', count: a.values.length };
    }
    if (externalLink(el)) fail('NAVIGATION_BLOCKED', 'Links leaving the artifact or downloading are excluded');
    const submitButton = submitElement(el);
    const submit = submitButton || a.kind === 'press' && a.key === 'Enter' && el.form && el.tagName === 'INPUT';
    if (submit && !a.submit) fail('SUBMIT_REQUIRES_FLAG', 'Set submit:true explicitly for form submission');
    if (submit) {
      // Default HTML submission would navigate/network or lose the opaque frame.
      // Permit artifact JS handlers, cancel the native navigation in all cases.
      const form = submitButton?.form || el.form;
      if (form.checkValidity && !form.checkValidity()) fail('FORM_INVALID','Form is invalid; native validation focus was not requested');
      if (typeof form.requestSubmit !== 'function') fail('UNSUPPORTED_ACTION','Form submission API is unavailable');
      const cancel = event => event.preventDefault();
      form.addEventListener('submit',cancel,true);
      try { if (a.kind === 'click') el.click(); else form.requestSubmit(submitButton || undefined); } finally { form.removeEventListener('submit',cancel,true); }
      return { changed: 'submit', nativeNavigationPrevented: true };
    }
    if (a.kind === 'click') { el.click(); return { changed: 'click', trusted: false }; }
    if (a.kind === 'press') {
      focus(el);
      const allowed = el.dispatchEvent(new win.KeyboardEvent('keydown', { key: a.key, bubbles: true, cancelable: true }));
      el.dispatchEvent(new win.KeyboardEvent('keyup', { key: a.key, bubbles: true }));
      // Synthetic key events do not implement browser default actions.
      return { changed: 'keyboard-event', key: a.key, trusted: false, defaultAction: false, cancelled: !allowed };
    }
    fail('UNSUPPORTED_ACTION', 'Unsupported artifact action');
  };
  return async function execute(cmd, signal) {
    const context = { sessionId: cmd.sessionId, ...cmd.args.target, path: cmd.path || null };
    let started = false;
    try {
      checkInput(cmd.name,cmd.args); guard(cmd,signal);
      const a = cmd.args;
      if (cmd.name === 'dsh_artifact_query') {
        const fields = a.fields || ['text','rect'], nodes = Array.from(doc.querySelectorAll(a.selector)).slice(0, (a.limit || LIMITS.nodes) + 1), matches = [];
        let chars = 0, budgetTruncated = false;
        for (const el of nodes.slice(0,a.limit || LIMITS.nodes)) {
          if (protectedElement(el)) continue;
          const item = { tag: el.tagName.toLowerCase() };
          if (fields.includes('text')) { item.text = text(el).slice(0, Math.max(0, 16000 - chars)); chars += item.text.length; }
          if (fields.includes('rect')) item.rect = rect(el);
          if (fields.includes('attrs')) item.attrs = Object.fromEntries(['id','role','aria-label','aria-expanded','aria-checked','data-testid','type'].filter(k => el.hasAttribute(k)).map(k => [k,String(el.getAttribute(k)).slice(0,256)]));
          if (fields.includes('style')) { const style = win.getComputedStyle(el); item.style = Object.fromEntries(['display','position','width','height','color','background-color','font-size','overflow-x','overflow-y','opacity'].map(k => [k,style.getPropertyValue(k).slice(0,128)])); }
          if (jsonBytes({matches:[...matches,item]}) > LIMITS.bytes-2048) { budgetTruncated = true;break; }
          matches.push(item);
        }
        return result(context,'none',{ matches, truncated: budgetTruncated || nodes.length > (a.limit || LIMITS.nodes) || chars >= 16000 },null,cmd.id);
      }
      if (cmd.name === 'dsh_artifact_wait') {
        const begun = now(), stop = Math.min(cmd.deadline, begun + (a.timeoutMs ?? LIMITS.timeout));
        while (true) {
          guard(cmd,signal);
          let satisfied;
          if (a.timeMs !== undefined) satisfied = now() - begun >= a.timeMs;
          else if (a.text !== undefined) satisfied = text(doc.body).includes(a.text);
          else { const found = doc.querySelector(a.selector); satisfied = (a.state === 'absent') ? !found : !!found && !protectedElement(found); }
          if (satisfied) return result(context,'none',{ satisfied: true, elapsedMs: now() - begun },null,cmd.id);
          if (now() >= stop) fail('TIMEOUT','Artifact wait condition was not met');
          await new Promise(resolve => { const t = setTimeout(done,50); function done() { clearTimeout(t); signal?.removeEventListener('abort',done); resolve(); } signal?.addEventListener('abort',done,{once:true}); });
        }
      }
      if (cmd.name === 'dsh_artifact_navigate') {
        const el = a.selector ? requireElement(a.selector) : a.hash ? doc.getElementById(a.hash.slice(1)) : null;
        if ((a.selector || a.hash) && !el) fail('ELEMENT_NOT_FOUND','Navigation target not found');
        if (el && protectedElement(el)) fail('PROTECTED_ELEMENT','Private navigation target');
        started = true;
        if (el) scrollWithinArtifact(el);
        if (a.hash) win.location.hash = a.hash;
        if (a.scroll) win.scrollTo({ left:a.scroll.x, top:a.scroll.y, behavior:'instant' });
        return result(context,'applied',{ changed:'navigation', hash:a.hash || null },null,cmd.id);
      }
      if (cmd.name === 'dsh_artifact_act') {
        // Errors thrown before dispatch retain effect:none. Any exception from an
        // event handler/DOM mutation may have partially applied and is unknown.
        const el = requireElement(a.action.selector);
        if (el.disabled || el.getAttribute?.('aria-disabled') === 'true') fail('ELEMENT_DISABLED','Element is disabled');
        // Preflight to avoid marking policy errors as ambiguous.
        if (['focus','press'].includes(a.action.kind) && !focusAllowed() && !(a.action.key === 'Enter' && a.action.submit && el.form)) fail('FOCUS_NOT_OWNED','Artifact does not own focus');
        started = true;
        const data = doAct(a.action);
        return result(context,'applied',data,null,cmd.id);
      }
      fail('UNSUPPORTED_ACTION','Command is not an iframe operation');
    } catch (e) {
      if (started && typeof e?.code !== 'string') return errorResult({code:'UNKNOWN_EFFECT',message:'Artifact action failed after dispatch',effect:'unknown'},context,cmd.id);
      return errorResult(e,context,cmd.id);
    }
  };
}

export function installIframeDispatcher(win = window) {
  let port, controller;
  const connect = event => {
    if (event.source !== win.parent || event.data?.type !== 'dsh-artifact-tools-v1-connect' || !event.ports?.[0] || typeof event.data.documentId !== 'string') return;
    controller?.abort(); port?.close();
    port = event.ports[0]; controller = new AbortController();
    const ownedPort = port, signal = controller.signal, seen = new Map();
    let focusOwned = false;
    const run = createIframeExecutor(win,{ documentId:event.data.documentId, focusAllowed:() => focusOwned });
    port.onmessage = async e => {
      if (e.data?.type === 'dispose') { if (port === ownedPort) controller.abort(); ownedPort.close(); return; }
      if (e.data?.type === 'focus-state') { focusOwned = e.data.owned === true; return; }
      const cmd = e.data?.command;
      for (const [id,deadline] of seen) if (Date.now() >= deadline) seen.delete(id);
      if (e.data?.type !== 'execute' || !cmd || seen.has(cmd.id)) return;
      if (seen.size >= 256) { ownedPort.postMessage({type:'result',id:cmd.id,value:errorResult({code:'DOCUMENT_COMMAND_LIMIT',message:'Too many unexpired document commands'}, {sessionId:cmd.sessionId,...cmd.args?.target},cmd.id)}); return; }
      seen.set(cmd.id,cmd.deadline);
      const value = await run(cmd,signal); if (port === ownedPort && !signal.aborted) ownedPort.postMessage({ type:'result', id:cmd.id, value });
    };
    port.start?.(); port.postMessage({ type:'ready', documentId:event.data.documentId });
  };
  win.addEventListener('message',connect);
  return () => { win.removeEventListener('message',connect); controller?.abort(); port?.close(); };
}
