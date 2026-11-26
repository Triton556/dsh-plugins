import { randomUUID, randomBytes, timingSafeEqual } from 'node:crypto';
import { LIMITS, VERSION, MUTATING, checkInput, fail, result, errorResult, boundResult, ToolError } from './contracts.js';

// Memory-only queue. No replay after restart. Journal contains metadata only.
export class CommandBroker {
  constructor({ now = Date.now, heartbeatMs = LIMITS.heartbeat } = {}) { this.now = now; this.heartbeatMs = heartbeatMs; this.clients = new Map(); this.commands = new Map(); this.journal = []; this.closed = false; }
  bind(sessionId) {
    const old = this.clients.get(sessionId);
    if (old) return { version: VERSION, sessionId, clientId: old.id, token: old.token };
    const client = { id: randomUUID(), token: randomBytes(32).toString('base64url'), seen: 0, instance: null };
    this.clients.set(sessionId, client);
    return { version: VERSION, sessionId, clientId: client.id, token: client.token };
  }
  authenticate({ sessionId, clientId, token }) {
    const c = this.clients.get(sessionId);
    if (this.closed || !c || c.id !== clientId || typeof token !== 'string' || Buffer.byteLength(token) !== Buffer.byteLength(c.token) || !timingSafeEqual(Buffer.from(token), Buffer.from(c.token))) fail('UNAUTHORIZED', 'Invalid bridge capability');
    return c;
  }
  log(command, status) {
    this.journal.push({ commandId: command.id, sessionId: command.sessionId, clientId: command.clientId, name: command.name, status, at: this.now() });
    if (this.journal.length > 256) this.journal.shift();
  }
  // A mounted renderer is the only thing that can execute. Freshness, not the
  // mere existence of a capability, decides whether a command may block.
  live(sessionId) {
    const c = this.clients.get(sessionId);
    return !this.closed && !!c && c.instance !== null && this.now() - c.seen < this.heartbeatMs;
  }
  pending(sessionId) {
    this.sweep();
    return [...this.commands.values()].filter(q => q.sessionId === sessionId && q.state === 'queued');
  }
  rows(sessionId) {
    return this.pending(sessionId).map((q, index) => ({ commandId: q.id, name: q.name, path: typeof q.args?.path === 'string' ? q.args.path : null, target: q.args?.target ?? null, position: index + 1, expiresAt: q.deadline }));
  }
  queuedResult(q) {
    const rows = this.rows(q.sessionId), row = rows.find(x => x.commandId === q.id);
    return result(q.context, 'none', { queued: true, pending: true, commandId: q.id, name: q.name, path: row?.path ?? null, position: row?.position ?? rows.length + 1, expiresAt: q.deadline }, null, q.id);
  }
  // A hidden caller session gets its request remembered, not refused. Only the
  // two command kinds that name a durable artifact path or tab id arrive here;
  // the host validates the path before enqueueing, so the queue grants nothing.
  enqueue(sessionId, name, args, { ttlMs = LIMITS.deferred } = {}) {
    checkInput(name, args); this.sweep();
    const c = this.clients.get(sessionId), context = { sessionId, ...args.target, path: args.path };
    if (this.closed || !c) return errorResult(new ToolError('UNAUTHORIZED', 'Session bridge is not registered'), context);
    const key = q => [q.name, q.args?.path ?? '', q.args?.target?.tabId ?? ''].join('\u0000');
    // Repeating the same request while it waits must not queue a second tab.
    const same = [...this.commands.values()].find(q => q.sessionId === sessionId && q.state === 'queued' && key(q) === key({ name, args }));
    if (same) return this.queuedResult(same);
    if ([...this.commands.values()].filter(q => q.sessionId === sessionId).length >= LIMITS.queue) return errorResult(new ToolError('QUEUE_FULL', 'Session command queue is full'), context);
    const q = { id: randomUUID(), name, args: structuredClone(args), context, sessionId, clientId: c.id, state: 'queued', deadline: this.now() + Math.min(Math.max(ttlMs, 1), LIMITS.deferred), waiting: false, deferrable: true, deferred: true, resolve: () => {}, signal: null, abort: null };
    this.commands.set(q.id, q); this.log(q, q.state);
    return this.queuedResult(q);
  }
  heartbeat(auth, instance) {
    const c = this.authenticate(auth);
    if (typeof instance !== 'string' || instance.length > 80 || !instance) fail('INVALID_INPUT', 'Invalid client instance');
    if (c.instance && c.instance !== instance && this.now() - c.seen < this.heartbeatMs) fail('CLIENT_OWNED', 'Another live client owns this session');
    if (c.instance && c.instance !== instance) this.detachCommands(c, 'Renderer connection expired');
    c.instance = instance; c.seen = this.now();
    return { version: VERSION, serverTime: this.now() };
  }
  // The renderer says goodbye on unmount (the user switched chats), so the host
  // stops pretending it is live instead of waiting out the heartbeat window.
  // Nothing that already ran is replayed; an unacknowledged deferrable command
  // returns to the queue because no side effect can have happened yet.
  bye(auth, instance) {
    const c = this.authenticate(auth);
    if (typeof instance !== 'string' || !instance) fail('INVALID_INPUT', 'Invalid client instance');
    if (c.instance !== instance) return { version: VERSION, detached: false };
    this.detachCommands(c, 'Renderer detached');
    c.instance = null; c.seen = 0;
    return { version: VERSION, detached: true };
  }
  detachCommands(client, reason) {
    for (const q of [...this.commands.values()]) {
      if (q.clientId !== client.id || !['delivered','started'].includes(q.state)) continue;
      if (this.now() >= q.deadline) { this.expire(q); continue; }
      if (q.state === 'delivered' && q.deferrable) {
        q.state = 'queued'; q.instance = null; this.log(q, 'requeued');
        continue;
      }
      const unknown = q.state === 'started' && MUTATING.has(q.name);
      this.finish(q, errorResult(new ToolError(unknown ? 'UNKNOWN_EFFECT' : 'ABORTED',
        unknown ? reason + ' after execution began; do not retry automatically' : reason + ' before completion',
        unknown ? 'unknown' : 'none'), q.context, q.id));
    }
  }
  poll(auth, instance) {
    this.heartbeat(auth, instance); this.sweep();
    // One unacknowledged command per session; no duplicate delivery/replay.
    if ([...this.commands.values()].some(q => q.sessionId === auth.sessionId && ['delivered','started'].includes(q.state))) return null;
    const q = [...this.commands.values()].find(q => q.sessionId === auth.sessionId && q.state === 'queued');
    if (!q) return null;
    // Time spent waiting for the session to become visible must not eat the
    // client's execution window: delivery starts a fresh one.
    q.deadline = Math.min(q.deadline, this.now() + LIMITS.timeout);
    q.state = 'delivered'; q.instance = instance; this.log(q, q.state);
    return { version: VERSION, id: q.id, name: q.name, args: q.args, sessionId: q.sessionId, clientId: q.clientId, deadline: q.deadline, ...(q.deferred ? { deferred: true } : {}) };
  }
  receipt(auth, instance, id, phase, value) {
    const c = this.authenticate(auth); const q = this.commands.get(id);
    if (!q || q.clientId !== c.id || q.sessionId !== auth.sessionId || q.instance !== instance || c.instance !== instance) fail('STALE_COMMAND', 'Command is no longer owned by this client');
    if (this.now() >= q.deadline) { this.expire(q); fail('STALE_COMMAND', 'Command deadline passed'); }
    if (phase === 'start') {
      if (q.state !== 'delivered') fail('STALE_COMMAND', 'Duplicate start receipt');
      q.state = 'started'; this.log(q, q.state); return { accepted: true };
    }
    if (phase !== 'done' || q.state !== 'started') fail('STALE_COMMAND', 'Unexpected receipt');
    boundResult(value);
    if (value.context.sessionId !== q.sessionId || value.commandId !== q.id) fail('INVALID_RECEIPT', 'Receipt target does not match command');
    // A queued close names a tab, not a document lease that survived the hidden
    // period; every other command must still report the exact document.
    if (q.args.target && (value.context.tabId !== q.args.target.tabId || (!q.deferred && value.context.documentId !== q.args.target.documentId))) fail('INVALID_RECEIPT', 'Receipt document does not match target');
    this.finish(q, value); return { accepted: true };
  }
  submit(sessionId, name, args, { timeoutMs = LIMITS.timeout, signal, defer = false } = {}) {
    checkInput(name, args); this.sweep();
    const c = this.clients.get(sessionId), context = { sessionId, ...args.target, path: args.path };
    if (this.closed || !c || !this.live(sessionId)) {
      if (defer && !this.closed && c) return Promise.resolve(this.enqueue(sessionId, name, args, { ttlMs: LIMITS.deferred }));
      return Promise.resolve(errorResult(new ToolError('CLIENT_STALE', 'No live client heartbeat'), context));
    }
    if ([...this.commands.values()].filter(q => q.sessionId === sessionId).length >= LIMITS.queue) return Promise.resolve(errorResult(new ToolError('QUEUE_FULL', 'Session command queue is full'), context));
    const id = randomUUID();
    return new Promise(resolve => {
      const limit = Math.min(Math.max(timeoutMs, 1), LIMITS.timeout);
      const q = { id, name, args: structuredClone(args), context, sessionId, clientId: c.id, state: 'queued', deadline: this.now() + limit, resolve, waiting: true, deferrable: defer === true, deferred: false };
      q.timer = setTimeout(() => this.expire(q), limit);
      // A rendered-but-deferrable call that no client picks up (switch away right
      // after the call, beacon lost) must not fail: after a short grace it reports
      // the queued state and keeps the intent. A delivered command is not touched.
      if (defer) q.graceTimer = setTimeout(() => this.expire(q, 'grace'), Math.min(LIMITS.grace, limit));
      q.abort = () => this.finish(q, errorResult(new ToolError(q.state === 'started' && MUTATING.has(name) ? 'UNKNOWN_EFFECT' : 'ABORTED', 'Caller cancelled command', q.state === 'started' && MUTATING.has(name) ? 'unknown' : 'none'), context, id));
      q.signal = signal;
      this.commands.set(id, q); this.log(q, q.state);
      if (signal?.aborted) q.abort(); else signal?.addEventListener('abort', q.abort, { once: true });
    });
  }
  expire(q, why) {
    if (!this.commands.has(q.id)) return;
    // The renderer went away after the call was accepted (the user switched to
    // another chat). Keep the intent queued and answer instead of failing.
    if (!this.closed && q.deferrable && q.state === 'queued' && q.waiting) {
      // The live call is over. Like enqueue(), deferred work is swept against
      // its current deadline, not against the original caller's timer.
      clearTimeout(q.timer); clearTimeout(q.graceTimer);
      q.timer = q.graceTimer = undefined;
      q.deadline = this.now() + LIMITS.deferred; q.waiting = false; q.deferred = true;
      if (q.signal) { q.signal.removeEventListener('abort', q.abort); q.signal = null; }
      q.abort = null; this.log(q, 'deferred'); q.resolve(this.queuedResult(q)); return;
    }
    // The grace timer only reports an undelivered command; a command the client
    // is already executing is governed by its own deadline.
    if (why === 'grace') return;
    const unknown = q.state === 'started' && MUTATING.has(q.name);
    this.finish(q, errorResult(new ToolError(unknown ? 'UNKNOWN_EFFECT' : 'TIMEOUT', unknown ? 'Deadline passed after execution began; do not retry automatically' : 'Command expired before completion', unknown ? 'unknown' : 'none'), q.context, q.id));
  }
  sweep() { for (const q of this.commands.values()) if (this.now() >= q.deadline) this.expire(q); }
  finish(q, value) {
    if (!this.commands.delete(q.id)) return;
    clearTimeout(q.timer); clearTimeout(q.graceTimer); q.signal?.removeEventListener('abort', q.abort); this.log(q, value.ok ? 'done' : value.error.code); q.args = null; q.resolve(value);
  }
  dispose() { this.closed = true; for (const q of [...this.commands.values()]) this.expire(q); this.clients.clear(); }
}

// Routes are never a bootstrap endpoint. Capability is obtained through the
// already authenticated DSH workspaceFiles remote, outside the artifact iframe.
export function createBridgeHandler(broker, { allowedOrigin, allowedHost }) {
  if (!allowedOrigin || !allowedHost) throw new Error('Explicit DSH origin/host required');
  const loopback = (address) => address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
  return async (req, res) => {
    const send = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(data)); };
    try {
      const origin = req.headers.origin;
      // The Desktop renderer reaches the Host through the dsh-app:// proxy,
      // which removes Origin and sec-fetch-site. Accept that carrier only from
      // loopback; the 256-bit capability token stays the authentication. A
      // browser Origin, when present, must still match exactly.
      const desktopCarrier = origin === undefined && loopback(req.socket.remoteAddress);
      if (req.method !== 'POST' || req.headers.host !== allowedHost || (origin !== undefined && origin !== allowedOrigin) || (origin === undefined && !desktopCarrier) || !String(req.headers['content-type'] || '').startsWith('application/json') || req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin') fail('UNAUTHORIZED', 'Same-origin JSON POST required');
      const chunks = []; let bytes = 0;
      for await (const chunk of req) { bytes += Buffer.byteLength(chunk); if (bytes > LIMITS.captureBytes) fail('PAYLOAD_TOO_LARGE', 'Bridge request too large'); chunks.push(Buffer.from(chunk)); }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!body || Object.keys(body).some(k => !['sessionId','clientId','instance','op','id','phase','value'].includes(k))) fail('INVALID_INPUT', 'Invalid bridge envelope');
      const auth = { sessionId: body.sessionId, clientId: body.clientId, token: String(req.headers.authorization || '').replace(/^Bearer /, '') };
      let data;
      if (body.op === 'poll') data = broker.poll(auth, body.instance);
      else if (body.op === 'heartbeat') data = broker.heartbeat(auth, body.instance);
      else if (body.op === 'bye') data = broker.bye(auth, body.instance);
      else if (body.op === 'receipt') data = broker.receipt(auth, body.instance, body.id, body.phase, body.value);
      else fail('INVALID_INPUT', 'Unknown bridge operation');
      send(200, { ok: true, data });
    } catch (e) { send(e.code === 'UNAUTHORIZED' ? 403 : 400, { ok: false, error: { code: e.code || 'INVALID_INPUT', message: e.code ? e.message : 'Invalid bridge request' } }); }
  };
}
