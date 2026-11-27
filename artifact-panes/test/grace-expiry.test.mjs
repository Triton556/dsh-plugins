import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CommandBroker } from '../tools/bridge.js';
import { LIMITS, result } from '../tools/contracts.js';

function setup(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const broker = new CommandBroker();
  t.after(() => broker.dispose());
  const auth = broker.bind('session');
  broker.heartbeat(auth, 'old');
  const submit = () => broker.submit(auth.sessionId, 'dsh_artifact_open',
    { path: 'artifacts/example.html' }, { defer: true });
  return { broker, auth, submit, tick: ms => t.mock.timers.tick(ms) };
}

test('open deferred after missed poll survives the original deadline and is delivered once', async t => {
  const { broker, auth, submit, tick } = setup(t);
  const pending = submit();
  tick(LIMITS.grace);
  const queued = await pending;
  assert.equal(queued.data.queued, true);
  assert.equal(queued.data.expiresAt, Date.now() + LIMITS.deferred);
  tick(LIMITS.timeout);
  assert.equal(broker.rows(auth.sessionId)[0]?.expiresAt, queued.data.expiresAt);
  const cmd = broker.poll(auth, 'returned');
  assert.equal(cmd?.id, queued.commandId);
  assert.equal(cmd.deferred, true);
  assert.equal(cmd.deadline, Date.now() + LIMITS.timeout);
  broker.receipt(auth, 'returned', cmd.id, 'start');
  broker.receipt(auth, 'returned', cmd.id, 'done', result({ sessionId: auth.sessionId }, 'applied', {}, null, cmd.id));
  assert.equal(broker.poll(auth, 'returned'), null);
});

test('grace-deferred open expires at the advertised boundary', async t => {
  const { broker, auth, submit, tick } = setup(t);
  const pending = submit();
  tick(LIMITS.grace);
  const queued = await pending;
  assert.equal(queued.data.queued, true);
  tick(LIMITS.deferred - 1);
  assert.equal(broker.rows(auth.sessionId)[0]?.commandId, queued.commandId);
  tick(1);
  assert.equal(Date.now(), queued.data.expiresAt);
  assert.equal(broker.poll(auth, 'returned'), null);
  assert.equal(broker.journal.at(-1).status, 'TIMEOUT');
});

test('a live open that started is not deferred or replayed on timeout', async t => {
  const { broker, auth, submit, tick } = setup(t);
  const pending = submit();
  const cmd = broker.poll(auth, 'old');
  broker.receipt(auth, 'old', cmd.id, 'start');
  tick(LIMITS.grace);
  assert.equal(broker.journal.at(-1).status, 'started');
  tick(LIMITS.timeout - LIMITS.grace);
  const receipt = await pending;
  assert.equal(receipt.error.code, 'UNKNOWN_EFFECT');
  assert.equal(receipt.effect, 'unknown');
  assert.equal(broker.poll(auth, 'returned'), null);
});
