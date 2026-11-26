// Isolated check of the deferred-command contract: a caller session that is not
// displayed must remember an open/close instead of refusing it, `tabs` must show
// what waits, and a document-bound command must fail fast and honestly.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const { registerArtifactTools } = await import('../tools/host.js');
const { CommandBroker } = await import('../tools/bridge.js');
const { LIMITS, result } = await import('../tools/contracts.js');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

const root = await mkdtemp(path.join(tmpdir(), 'artifact-panes-queue-'));
await mkdir(path.join(root, 'artifacts'), { recursive: true });
for (let i = 0; i < 40; i += 1) {
  await writeFile(path.join(root, 'artifacts', 'page-' + i + '.html'), '<!doctype html><title>p</title>', 'utf8');
}

// A tool set identical to the production registration, with an injectable broker
// so the "client" can be played by the test.
function rig(options = {}) {
  const broker = new CommandBroker(options);
  const tools = new Map();
  registerArtifactTools({
    tools: { register: definition => { tools.set(definition.name, definition); return () => tools.delete(definition.name); } },
    webServer: { register: () => () => {} },
  }, { defineTool: spec => spec, origin: 'http://127.0.0.1:1', host: '127.0.0.1:1', broker,
    // A native attachment service exists in production; without it the
    // screenshot tool fails before the bridge and would hide the hidden-session
    // answer this test is about.
    attachments: { saveImages: async () => [{ attachmentId: 'att-1' }] } });
  const sessionId = 'session-hidden';
  const exec = { agent: { session: { id: sessionId, header: { cwd: root } } }, signal: new AbortController().signal };
  return {
    broker, sessionId, exec, tools,
    call: (name, args) => tools.get(name).execute(args, exec),
    auth: () => { const c = broker.bind(sessionId); return { sessionId, clientId: c.clientId, token: c.token }; },
  };
}

// 1. A hidden session queues the open and answers at once with a real state.
{
  const { broker, sessionId, call, auth } = rig();
  const started = Date.now();
  const opened = await call('dsh_artifact_open', { path: 'artifacts/page-0.html' });
  assert.equal(opened.ok, true);
  assert.equal(opened.effect, 'none', 'no tab exists yet, so nothing was applied');
  assert.equal(opened.error, null);
  assert.equal(opened.data.queued, true);
  assert.equal(opened.data.position, 1);
  assert.ok(opened.data.expiresAt - Date.now() > LIMITS.deferred - 5000, 'the queue holds it for the long deadline');
  assert.equal(opened.context.tabId, null, 'a queued request must not claim a tab');
  assert.ok(typeof opened.commandId === 'string' && opened.commandId);
  assert.ok(Date.now() - started < 2000, 'the call returns instead of waiting for a client');

  // 2. A repeat of the same path collapses into the same request.
  const again = await call('dsh_artifact_open', { path: 'artifacts/page-0.html' });
  assert.equal(again.data.queued, true);
  assert.equal(again.commandId, opened.commandId, 'the same path is one request');
  assert.equal(broker.rows(sessionId).length, 1);

  // 3. tabs shows the queue and says the live tab list is unknown.
  const tabs = await call('dsh_artifact_tabs', {});
  assert.equal(tabs.ok, true);
  assert.equal(tabs.data.live, false);
  assert.equal(tabs.data.tabs.length, 1);
  assert.equal(tabs.data.tabs[0].pending, true);
  assert.equal(tabs.data.tabs[0].path, 'artifacts/page-0.html');
  assert.equal(tabs.data.tabs[0].commandId, opened.commandId);
  assert.equal(tabs.data.tabs[0].tabId, null);

  // 4. Document-bound commands refuse fast with a code the agent can act on.
  for (const [name, args] of [
    ['dsh_artifact_act', { target: { tabId: 't', documentId: 'd' }, action: { kind: 'click', selector: 'button' } }],
    ['dsh_artifact_query', { target: { tabId: 't', documentId: 'd' }, selector: 'body' }],
    ['dsh_artifact_screenshot', { target: { tabId: 't', documentId: 'd' } }],
    ['dsh_artifact_close', { target: { tabId: 't', documentId: 'd' } }],
  ]) {
    // close is deferrable, so it queues rather than refusing; the rest refuse.
    const value = await call(name, args);
    if (name === 'dsh_artifact_close') {
      assert.equal(value.ok, true);
      assert.equal(value.data.queued, true);
      assert.equal(value.data.position, 2, 'the close waits behind the open');
    } else {
      assert.equal(value.ok, false);
      assert.equal(value.error.code, 'SESSION_NOT_VISIBLE', name + ' must say the session is hidden');
      assert.equal(value.effect, 'none');
      assert.equal(value.data.queued, undefined, 'a refusal is not a queued success');
    }
  }

  // 5. The connection is not touched by an invalid path: nothing is queued.
  const outside = await call('dsh_artifact_open', { path: 'artifacts/../../escape.html' });
  assert.equal(outside.ok, false);
  assert.equal(outside.error.code, 'PATH_OUT_OF_SCOPE');
  assert.equal(broker.rows(sessionId).length, 2, 'the rejected path added no request');

  // 6. Panel opens follow the same split: an artifact is deferred, other kinds
  // need the live panel.
  const panelArtifact = await call('dsh_ui_panel_open', { kind: 'artifact', path: 'artifacts/page-6.html' });
  assert.equal(panelArtifact.ok, true);
  assert.equal(panelArtifact.data.queued, true);
  const panelFiles = await call('dsh_ui_panel_open', { kind: 'files', path: 'artifacts' });
  assert.equal(panelFiles.error.code, 'SESSION_NOT_VISIBLE');

  // 7. The description carries the contract the agent reads.
  assert.ok(LIMITS.deferred >= 60000);
  const catalog = (await import('../tools/contracts.js')).CATALOG;
  assert.match(catalog.find(x => x.name === 'dsh_artifact_act').description, /SESSION_NOT_VISIBLE/);
  assert.match(catalog.find(x => x.name === 'dsh_artifact_open').description, /queued/);
}

// 7. Returning to the session: the client polls on mount and runs the queued
// request by itself, without a second tool call.
{
  const { broker, sessionId, call, auth } = rig();
  const queued = await call('dsh_artifact_open', { path: 'artifacts/page-1.html' });
  const authValue = auth(), instance = 'instance-1';
  const cmd = broker.poll(authValue, instance);
  assert.ok(cmd, 'the mount poll receives the queued request');
  assert.equal(cmd.id, queued.commandId);
  assert.equal(cmd.name, 'dsh_artifact_open');
  assert.equal(cmd.args.path, 'artifacts/page-1.html');
  assert.equal(cmd.deferred, true, 'the client knows this waited in the queue');
  assert.ok(cmd.deadline - Date.now() <= LIMITS.timeout + 50, 'delivery starts a fresh execution window');
  broker.receipt(authValue, instance, cmd.id, 'start');
  assert.equal(broker.rows(sessionId).length, 0, 'a delivered request leaves the queue');
  broker.receipt(authValue, instance, cmd.id, 'done', result({ sessionId, tabId: 'tab-1', documentId: 'doc-1', path: 'artifacts/page-1.html' }, 'applied', { opened: true }, null, cmd.id));
  assert.equal(broker.live(sessionId), true);

  // With the renderer back, tabs reports real tabs and no pending rows.
  let running = true;
  const loop = (async () => {
    while (running) {
      const next = broker.poll(authValue, instance);
      if (!next) { await delay(5); continue; }
      broker.receipt(authValue, instance, next.id, 'start');
      broker.receipt(authValue, instance, next.id, 'done', result({ sessionId }, 'none', {
        tabs: [{ tabId: 'tab-1', documentId: 'doc-1', path: 'artifacts/page-1.html', kind: 'artifact', ready: true, active: true }],
      }, null, next.id));
    }
  })();
  try {
    const tabs = await call('dsh_artifact_tabs', {});
    assert.equal(tabs.ok, true);
    assert.equal(tabs.data.live, true);
    assert.equal(tabs.data.pending, 0);
    assert.equal(tabs.data.tabs.length, 1);
    assert.equal(tabs.data.tabs[0].tabId, 'tab-1');
    assert.equal(tabs.data.tabs[0].pending, false);

    // 9. A close queued while hidden is executed by tab id, and its receipt may
    // name the document that replaced the original lease (see the next block).
    running = false; await loop;
  } finally { running = false; }
}

// 9. The deferred close: enqueue while hidden, then execute with a new document.
{
  const { broker, sessionId, call, auth } = rig({ heartbeatMs: 40 });
  const authValue = auth(), instance = 'instance-2';
  broker.heartbeat(authValue, instance);
  assert.equal(broker.live(sessionId), true);
  await delay(60);
  assert.equal(broker.live(sessionId), false, 'the heartbeat expired, the session is hidden');
  const closed = await call('dsh_artifact_close', { target: { tabId: 'tab-9', documentId: 'doc-old' } });
  assert.equal(closed.ok, true);
  assert.equal(closed.data.queued, true);
  assert.equal(closed.data.path, null);
  const tabs = await call('dsh_artifact_tabs', {});
  assert.equal(tabs.data.tabs[0].tabId, 'tab-9', 'the pending close names its tab');
  assert.equal(tabs.data.tabs[0].request, 'dsh_artifact_close');

  const cmd = broker.poll(authValue, instance);
  assert.equal(cmd.name, 'dsh_artifact_close');
  assert.equal(cmd.deferred, true);
  broker.receipt(authValue, instance, cmd.id, 'start');
  // The tab now holds a different document: a queued close must still be
  // accepted, because its durable identity is the tab, not the old lease.
  const done = broker.receipt(authValue, instance, cmd.id, 'done', result({ sessionId, tabId: 'tab-9', documentId: 'doc-new' }, 'applied', { closed: true, queuedBeforeMount: true }, null, cmd.id));
  assert.deepEqual(done, { accepted: true });
}

// 10. A live, non-deferred command still has to name the exact document.
{
  const broker = new CommandBroker({ heartbeatMs: 1000 });
  const sessionId = 'session-live';
  const capability = broker.bind(sessionId), instance = 'instance-3';
  const auth = { sessionId, clientId: capability.clientId, token: capability.token };
  broker.heartbeat(auth, instance);
  const pending = broker.submit(sessionId, 'dsh_artifact_close', { target: { tabId: 'tab-2', documentId: 'doc-1' } }, {});
  const cmd = broker.poll(auth, instance);
  broker.receipt(auth, instance, cmd.id, 'start');
  assert.equal(cmd.deferred, undefined, 'a live command is not marked deferred');
  assert.throws(
    () => broker.receipt(auth, instance, cmd.id, 'done', result({ sessionId, tabId: 'tab-2', documentId: 'doc-2' }, 'applied', {}, null, cmd.id)),
    error => error.code === 'INVALID_RECEIPT',
    'a live receipt cannot report another document',
  );
  broker.dispose();
  const value = await pending;
  assert.equal(value.ok, false);
}

// 11. A call accepted while live, whose client vanishes before polling, stays
// queued instead of failing: the user switched chats right after the call.
{
  const broker = new CommandBroker({ heartbeatMs: 1000 });
  const sessionId = 'session-switched';
  const capability = broker.bind(sessionId), instance = 'instance-4';
  const auth = { sessionId, clientId: capability.clientId, token: capability.token };
  broker.heartbeat(auth, instance);
  const value = await broker.submit(sessionId, 'dsh_artifact_open', { path: 'artifacts/page-2.html' }, { defer: true, timeoutMs: 20 });
  assert.equal(value.ok, true);
  assert.equal(value.effect, 'none');
  assert.equal(value.data.queued, true);
  assert.ok(value.data.expiresAt - Date.now() > LIMITS.deferred - 5000, 'the intent is kept for the long deadline');
  assert.equal(broker.rows(sessionId).length, 1);
  const cmd = broker.poll(auth, instance);
  assert.equal(cmd.id, value.commandId, 'the delayed request is still the one the client picks up');
  assert.equal(cmd.deferred, true);
  broker.dispose();
}

// 12. The renderer says goodbye when the user switches chats: the host stops
// believing it is live at once, keeps an unacknowledged open queued, and marks a
// command that already began as unknown instead of replaying it.
{
  const broker = new CommandBroker({ heartbeatMs: 6000 });
  const sessionId = 'session-bye';
  const capability = broker.bind(sessionId), instance = 'instance-5';
  const auth = { sessionId, clientId: capability.clientId, token: capability.token };
  broker.heartbeat(auth, instance);
  assert.equal(broker.live(sessionId), true);

  // Delivered but not acknowledged: the intent must survive.
  const opening = broker.submit(sessionId, 'dsh_artifact_open', { path: 'artifacts/page-7.html' }, { defer: true });
  const delivered = broker.poll(auth, instance);
  assert.equal(delivered.name, 'dsh_artifact_open');
  assert.deepEqual(broker.bye(auth, instance), { version: 1, detached: true });
  assert.equal(broker.live(sessionId), false, 'the goodbye is immediate, not heartbeat-delayed');
  assert.equal(broker.rows(sessionId).length, 1, 'the unacknowledged open is queued again');
  // A different client instance may now take the session over.
  broker.heartbeat(auth, 'instance-6');
  const redelivered = broker.poll(auth, 'instance-6');
  assert.equal(redelivered.id, delivered.id, 'the same request, not a duplicate');
  broker.receipt(auth, 'instance-6', redelivered.id, 'start');
  broker.receipt(auth, 'instance-6', redelivered.id, 'done', result({ sessionId, tabId: 'tab-7', documentId: 'doc-7', path: 'artifacts/page-7.html' }, 'applied', { opened: true }, null, redelivered.id));
  const opened = await opening;
  assert.equal(opened.ok, true, 'the caller still gets the real result');
  assert.equal(opened.effect, 'applied');

  // Started and then detached: no replay, honest unknown.
  const started = broker.submit(sessionId, 'dsh_artifact_act', { target: { tabId: 'tab-7', documentId: 'doc-7' }, action: { kind: 'click', selector: 'button' } }, {});
  const command = broker.poll(auth, 'instance-6');
  broker.receipt(auth, 'instance-6', command.id, 'start');
  broker.bye(auth, 'instance-6');
  const value = await started;
  assert.equal(value.ok, false);
  assert.equal(value.error.code, 'UNKNOWN_EFFECT');
  assert.equal(value.effect, 'unknown');

  // A stale goodbye cannot clear the instance that replaced it.
  broker.heartbeat(auth, 'instance-7');
  assert.deepEqual(broker.bye(auth, 'instance-6'), { version: 1, detached: false });
  assert.equal(broker.live(sessionId), true);
  broker.dispose();
}

// 13. Queue limits are per session and do not damage the requests already there.
{
  const { broker, sessionId, call } = rig();
  const first = await call('dsh_artifact_open', { path: 'artifacts/page-3.html' });
  assert.equal(first.data.position, 1);
  let accepted = 1, rejected = null;
  for (let i = 4; i < 40 && !rejected; i += 1) {
    const value = await call('dsh_artifact_open', { path: 'artifacts/page-' + i + '.html' });
    if (value.ok) accepted += 1; else rejected = value;
  }
  assert.ok(rejected, 'the queue limit is enforced');
  assert.equal(rejected.error.code, 'QUEUE_FULL');
  assert.equal(accepted, LIMITS.queue);
  const tabs = await call('dsh_artifact_tabs', {});
  assert.equal(tabs.data.tabs.length, LIMITS.queue, 'the accepted requests survive the overflow');
  assert.ok(tabs.data.tabs.every(row => row.pending === true));
  const orders = tabs.data.tabs.map(row => row.position);
  assert.deepEqual(orders, orders.map((_, index) => index + 1), 'positions are stable and 1-based');
}

// 14. An expired request disappears from tabs; a fresh broker per TTL keeps the
// real clock in play.
{
  const broker = new CommandBroker();
  const sessionId = 'session-ttl';
  broker.bind(sessionId);
  broker.enqueue(sessionId, 'dsh_artifact_open', { path: 'artifacts/page-5.html' }, { ttlMs: 10 });
  assert.equal(broker.rows(sessionId).length, 1);
  await delay(25);
  assert.equal(broker.rows(sessionId).length, 0, 'the expired request is gone');
  broker.dispose();
}

// 15. A call accepted while the renderer looks fresh but has already left (the
// goodbye beacon was lost) reports the queued state after a short grace instead
// of failing or hanging until the tool timeout.
{
  const { broker, sessionId, call, auth } = rig({ heartbeatMs: 6000 });
  const authValue = auth(), instance = 'instance-8';
  broker.heartbeat(authValue, instance);
  assert.equal(broker.live(sessionId), true);
  const started = Date.now();
  const value = await call('dsh_artifact_open', { path: 'artifacts/page-8.html' });
  const elapsed = Date.now() - started;
  assert.equal(value.ok, true);
  assert.equal(value.data.queued, true);
  assert.ok(elapsed >= LIMITS.grace - 250 && elapsed < LIMITS.timeout, 'answered after the grace, far before the tool timeout: ' + elapsed + 'ms');
  assert.equal(broker.rows(sessionId).length, 1, 'the intent is still queued');
  const delivered = broker.poll(authValue, instance);
  assert.equal(delivered.id, value.commandId);
  broker.dispose();
}

await rm(root, { recursive: true, force: true });
console.log('artifact-panes deferred queue: OK');
console.log('  queue limit:', LIMITS.queue, '| deferred ttl:', LIMITS.deferred, 'ms');
